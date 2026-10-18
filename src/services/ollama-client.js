/**
 * OllamaClient — the ONLY place that talks to Ollama's HTTP API.
 *
 * Every subsystem (curator, critic, planner, brain) goes through this one file,
 * which is what makes `OLLAMA_FIXTURE=true` able to stub the entire pipeline:
 * you can smoke-test the full loop before burning a single VRAM byte.
 *
 * deepseek-r1 caveat baked in: r1 is a *reasoning* model. When wrapped behind
 * Ollama it can leak its chain-of-thought into the final answer, and for the
 * RLHF-style distills the CoT lives in `message.reasoning`. We strip both, and
 * we pin the model tag to whatever `ollama list` shows (default `:latest`,
 * which on consumer rigs is a 4-7GB distill, NOT the 671B MoE).
 */

export class OllamaClient {
  constructor(opts = {}) {
    this.endpoint = opts.endpoint ?? process.env.OLLAMA_ENDPOINT ?? "http://localhost:11434";
    this.model = opts.model ?? process.env.OLLAMA_MODEL ?? "deepseek-r1:latest";
    this.fixture = opts.fixture ?? process.env.OLLAMA_FIXTURE === "true";
    this.defaultOptions = {
      temperature: opts.temperature ?? 0.7,
      top_p: opts.topP ?? 0.95,
      // NOTE: no num_predict here on purpose. deepseek-r1:latest counts its
      // hidden chain-of-thought tokens against num_predict; a tight cap burns
      // the whole budget on reasoning and returns an EMPTY final answer (seen
      // live during bring-up: num_predict=2048 -> content length 0, eval=2048).
      // Only set it when a caller explicitly passes maxTokens.
    };
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async #request(path, body, stream = false) {
    const res = await fetch(`${this.endpoint}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ollama ${path} ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!stream) return res.json();
    return res;
  }

  /** Non-streaming chat. Returns final text with any CoT stripped. */
  async chat({ messages, format, temperature, maxTokens, repeatPenalty }) {
    if (this.fixture) return { text: this.#fixtureReply(messages) };
    const options = { ...this.defaultOptions, temperature: temperature ?? this.defaultOptions.temperature };
    // A hard cap bounds a runaway reasoning model. deepseek-r1 counts hidden
    // chain-of-thought against num_predict, so an uncapped call can burn the
    // server's repeat limit and return an empty final answer.
    if (maxTokens) options.num_predict = maxTokens;
    // Repeat penalty discourages the degenerate token loop that trips the
    // server's repeat limit in the first place.
    if (Number.isFinite(Number(repeatPenalty)) && Number(repeatPenalty) > 0) {
      options.repeat_penalty = Number(repeatPenalty);
    }
    const body = await this.#request("/api/chat", {
      model: this.model,
      messages,
      stream: false,
      ...(format ? { format } : {}),
      options,
    });
    return {
      text: this.#stripReasoning(body.message?.content ?? ""),
      reasoning: body.message?.reasoning ?? null,
      promptEvalCount: body.prompt_eval_count ?? null,
      evalCount: body.eval_count ?? null,
    };
  }

  /**
   * Streaming chat as an async generator — yields { token, done }.
   * The generator contract lets callers implement real backpressure: reading
   * the next token is bounded by `reader.read()`, so a slow consumer naturally
   * backpressures TCP without buffering the whole model response in RAM.
   */
  async *streamChat({ messages, temperature = 0.7 }) {
    if (this.fixture) {
      yield { token: " [fixture stream] ", done: false };
      yield { token: "> ", done: false };
      yield { token: this.#fixtureReply(messages), done: true };
      return;
    }
    const res = await this.#request(
      "/api/chat",
      { model: this.model, messages, stream: true, options: { ...this.defaultOptions, temperature } },
      true
    );
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        yield { token: "", done: true };
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let part;
        try {
          part = JSON.parse(line);
        } catch {
          continue;
        }
        yield { token: this.#stripReasoning(part.message?.content ?? ""), done: part.done ?? false, reasoning: part.message?.reasoning ?? null };
        if (part.done) return;
      }
    }
  }

  /**
   * Shorthand for the "clean raw text into ARTICLE UNITS" job.
   *
   * The training unit is a single continuous prose ARTICLE, never a
   * {prompt, completion} pair. The legacy pair shape was the curator's original
   * contract and is still ACCEPTED on input for backward compatibility, but it
   * is normalised to `{ text, domain }` so the whole pipeline sees one schema
   * (defect D11).
   */
  async clean(rawText, { maxTokens = 4096 } = {}) {
    const { text } = await this.chat({
      format: "json",
      temperature: 0.2, // cleaning should be deterministic, not creative
      maxTokens,
      messages: [
        {
          role: "system",
          content: [
            "You are a text curation pipeline stage.",
            "Clean, filter and structure the user's raw scraped text into JSON.",
            "Rules:",
            '  - Return ONLY a JSON array of ARTICLE UNITS: [{ "text": string, "domain": string }]',
            "  - Each unit is ONE self-contained, continuous prose passage worth learning from.",
            "  - Drop boilerplate, nav menus, ads, markup, and anything unsafe/PII.",
            "  - If the text is unusable (junk/garbage), return [].",
            "  - domain = one of: science, tech, history, general, fiction, howto.",
          ].join("\n"),
        },
        { role: "user", content: rawText.slice(0, 14_000) },
      ],
    });
    return this.#parseUnits(text);
  }

  /**
   * Normalise a loose critic/curator JSON response into `[{ text, domain }]`.
   * Accepts both the article-unit shape and the legacy `{prompt, completion}`.
   */
  #parseUnits(text) {
    const isUnit = (t) => t && typeof t === "object" && typeof t.text === "string";
    const isLegacyPair = (t) => t && typeof t === "object" && typeof t.prompt === "string" && typeof t.completion === "string";
    const normalize = (t) =>
      isUnit(t)
        ? { text: t.text, domain: t.domain }
        : { text: `${t.prompt}\n\n${t.completion ?? ""}`.trim(), domain: t.domain };

    const trimmed = String(text).trim();
    const firstArr = trimmed.indexOf("[");
    const lastArr = trimmed.lastIndexOf("]");
    if (firstArr !== -1 && lastArr > firstArr) {
      try {
        const arr = JSON.parse(trimmed.slice(firstArr, lastArr + 1));
        if (Array.isArray(arr)) {
          const out = arr.filter((t) => isUnit(t) || isLegacyPair(t));
          if (out.length) return out.map(normalize);
        }
      } catch {
        /* fall through to object form */
      }
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace <= firstBrace) return [];
    let root;
    try {
      root = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      return [];
    }
    const arr = Array.isArray(root) ? root : root && Array.isArray(root.results) ? root.results : Array.isArray(root.units) ? root.units : [root];
    return arr.filter((t) => isUnit(t) || isLegacyPair(t)).map(normalize);
  }

  #stripReasoning(content) {
    let s = String(content ?? "");
    s = s.replace(/<[\s\S]*?think[\s\S]*?>/gi, "");
    s = s.replace(/<\/?think>/gi, "");
    return s.trim();
  }

  #fixtureReply(messages) {
    const user = [...messages].reverse().find((m) => m.role === "user");
    const raw = String(user?.content ?? "");
    const systemText = messages
      .filter((m) => m.role === "system")
      .map((m) => String(m.content ?? ""))
      .join("\n");

    // The critic is identified by markers that are ACTUALLY in the shipped
    // CRITIC_PROMPT ("harsh but fair teacher" / ARTICLE / suggestedImportance),
    // not by a phrase the prompt never contained ("reward model" — the old
    // matcher). Detecting the wrong persona made the fixture return a generic
    // echo with no `score`, which silently became a neutral 5 and lost every
    // article to `uncertain`.
    const isCritic =
      /harsh but fair teacher/i.test(systemText) ||
      /suggestedImportance/i.test(systemText) ||
      /reviewing a single ARTICLE/i.test(systemText);
    const isCurator = /curation pipeline/i.test(systemText);

    // Critic fixture: return the EXACT strict-JSON shape the critic prompt asks
    // for, so `score` is always present and parseable.
    if (isCritic) {
      return JSON.stringify({
        score: 6.5,
        rationale: "fixture critic: plausible, low repetition",
        suggestedImportance: "Normal",
      });
    }
    if (isCurator) {
      const first = raw.split("\n").find((l) => l.trim() && !l.trim().startsWith("||"));
      const body = (first ?? raw).replace(/[|]+/g, "").trim().slice(0, 160);
      return JSON.stringify([
        { text: body, domain: body.length ? "general" : "junk" },
        { text: `Fact-check: ${body}`, domain: "factcheck" },
      ]);
    }
    return `{ "fixture": true, "echo": ${JSON.stringify(raw.slice(0, 120))} }`;
  }
}