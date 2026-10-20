export const BLUEPRINT_SCHEMA = "sma/brain-blueprint@1";

export const COMPONENT_COLORS = {
  model: "#9aa7b8",
  embedding: "#5eead4",
  positional_encoding: "#a78bfa",
  transformer_block: "#4ea1ff",
  attention: "#f472b6",
  linear_projection: "#60a5fa",
  mlp: "#f59e0b",
  activation: "#fbbf24",
  elementwise: "#fb923c",
  normalization: "#34d399",
  residual: "#94a3b8",
  output_head: "#e879f9",
  buffer: "#64748b",
};

export const CONNECTION_COLORS = {
  dataflow: "#3b82f6",
  residual: "#94a3b8",
  positional_encoding: "#a78bfa",
  tied_parameter: "#e879f9",
  branch: "#f59e0b",
};

const REQUIRED_TOP = [
  "schema",
  "exportedAt",
  "source",
  "model",
  "parameterAccounting",
  "components",
  "connections",
  "counts",
];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isId = (value) => typeof value === "string" && value.length > 0;

function requireObject(errors, value, label) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  return true;
}

function requireString(errors, value, label) {
  if (typeof value !== "string") {
    errors.push(`${label} must be a string`);
    return false;
  }
  return true;
}

function validateComponent(errors, component, index) {
  if (!requireObject(errors, component, `components[${index}]`)) return null;
  if (!isId(component.id)) errors.push(`components[${index}].id must be a non-empty string`);
  requireString(errors, component.name, `components[${index}].name`);
  requireString(errors, component.type, `components[${index}].type`);
  if (component.parentId !== null && component.parentId !== undefined && !isId(component.parentId)) {
    errors.push(`components[${index}].parentId must be a string or null`);
  }
  if (component.blockIndex !== null && component.blockIndex !== undefined && !Number.isInteger(component.blockIndex)) {
    errors.push(`components[${index}].blockIndex must be an integer or null`);
  }
  requireObject(errors, component.dimensions ?? {}, `components[${index}].dimensions`);
  if (!Array.isArray(component.tensors ?? [])) errors.push(`components[${index}].tensors must be an array`);
  if (!isObject(component.parameters ?? {})) errors.push(`components[${index}].parameters must be an object`);
  if (!isObject(component.metadata ?? {})) errors.push(`components[${index}].metadata must be an object`);
  return component.id ?? null;
}

function validateConnection(errors, connection, index) {
  if (!requireObject(errors, connection, `connections[${index}]`)) return null;
  if (!isId(connection.id)) errors.push(`connections[${index}].id must be a non-empty string`);
  if (!isId(connection.from)) errors.push(`connections[${index}].from must be a non-empty string`);
  if (!isId(connection.to)) errors.push(`connections[${index}].to must be a non-empty string`);
  requireString(errors, connection.type, `connections[${index}].type`);
  if (typeof connection.explicit !== "boolean" && typeof connection.inferred !== "boolean") {
    errors.push(`connections[${index}] must say whether it is explicit or inferred`);
  }
  if (!isObject(connection.dimensions ?? {})) errors.push(`connections[${index}].dimensions must be an object`);
  return connection.id ?? null;
}

export function validateBlueprint(value) {
  const errors = [];
  const warnings = [];
  if (!requireObject(errors, value, "blueprint")) return { ok: false, errors, warnings };
  for (const key of REQUIRED_TOP) {
    if (!(key in value)) errors.push(`missing required field: ${key}`);
  }
  if (value.schema !== BLUEPRINT_SCHEMA) {
    errors.push(`schema must be ${BLUEPRINT_SCHEMA}, got ${JSON.stringify(value.schema)}`);
  }
  requireString(errors, value.exportedAt, "exportedAt");
  if (requireObject(errors, value.source, "source")) {
    requireString(errors, value.source.activeVersion, "source.activeVersion");
    if (value.source.weightsLoaded !== false) {
      errors.push("source.weightsLoaded must be false; this visualisation never loads weights");
    }
  }
  if (requireObject(errors, value.model, "model")) {
    requireString(errors, value.model.version, "model.version");
    requireString(errors, value.model.architecture, "model.architecture");
  }
  if (requireObject(errors, value.parameterAccounting, "parameterAccounting")) {
    const accounting = value.parameterAccounting;
    for (const key of ["totalParameters", "uniqueTrainable", "tensorElements"]) {
      if (!isNumber(accounting[key])) errors.push(`parameterAccounting.${key} must be a finite number`);
    }
    if (!isObject(accounting.verification)) {
      errors.push("parameterAccounting.verification must be an object");
    } else {
      const status = accounting.verification.status;
      if (!["verified", "unverified", "mismatch"].includes(status)) {
        errors.push(`parameterAccounting.verification.status is invalid: ${JSON.stringify(status)}`);
      }
      if (status !== "verified") warnings.push(`parameter accounting is ${status}, not independently verified`);
    }
  }

  const componentIds = new Set();
  if (!Array.isArray(value.components)) {
    errors.push("components must be an array");
  } else {
    value.components.forEach((component, index) => {
      const id = validateComponent(errors, component, index);
      if (!id) return;
      if (componentIds.has(id)) errors.push(`duplicate component id: ${id}`);
      componentIds.add(id);
    });
    for (const component of value.components) {
      if (isObject(component) && component.parentId && !componentIds.has(component.parentId)) {
        errors.push(`component ${component.id} names a missing parent: ${component.parentId}`);
      }
    }
  }

  const connectionIds = new Set();
  if (!Array.isArray(value.connections)) {
    errors.push("connections must be an array");
  } else {
    value.connections.forEach((connection, index) => {
      const id = validateConnection(errors, connection, index);
      if (!id) return;
      if (connectionIds.has(id)) errors.push(`duplicate connection id: ${id}`);
      connectionIds.add(id);
    });
    for (const connection of value.connections) {
      if (!isObject(connection)) continue;
      if (!componentIds.has(connection.from)) errors.push(`connection ${connection.id} has a missing source: ${connection.from}`);
      if (!componentIds.has(connection.to)) errors.push(`connection ${connection.id} has a missing destination: ${connection.to}`);
      if (connection.from === connection.to) errors.push(`connection ${connection.id} is a self-edge`);
    }
  }

  if (requireObject(errors, value.counts, "counts")) {
    if (Array.isArray(value.components) && value.counts.components !== value.components.length) {
      errors.push(`counts.components is ${value.counts.components}, expected ${value.components.length}`);
    }
    if (Array.isArray(value.connections) && value.counts.connections !== value.connections.length) {
      errors.push(`counts.connections is ${value.counts.connections}, expected ${value.connections.length}`);
    }
  }
  if (value.warnings !== undefined && !Array.isArray(value.warnings)) {
    errors.push("warnings must be an array when present");
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function blueprintSummary(blueprint) {
  if (!isObject(blueprint)) return null;
  const verification = blueprint.parameterAccounting?.verification ?? {};
  return {
    version: blueprint.source?.activeVersion ?? blueprint.model?.version ?? null,
    artifactName: blueprint.source?.artifactName ?? blueprint.model?.id ?? null,
    exportedAt: blueprint.exportedAt ?? null,
    architecture: blueprint.model?.architecture ?? null,
    configName: blueprint.model?.configName ?? null,
    layers: blueprint.model?.counts?.layers ?? blueprint.counts?.layers ?? null,
    components: blueprint.counts?.components ?? blueprint.components?.length ?? null,
    connections: blueprint.counts?.connections ?? blueprint.connections?.length ?? null,
    parameters: blueprint.parameterAccounting?.totalParameters ?? null,
    verification: verification.status ?? "unknown",
    weightsInspected: blueprint.source?.weightsInspected ?? null,
    warnings: Array.isArray(blueprint.warnings) ? blueprint.warnings.length : 0,
    initialisation: blueprint.model?.initialisation ?? null,
  };
}

function componentMap(blueprint) {
  return new Map((blueprint?.components ?? []).map((component) => [component.id, component]));
}

export function parentBlock(blueprint, component) {
  if (!component) return null;
  if (component.type === "transformer_block") return component;
  const map = componentMap(blueprint);
  let current = component;
  let guard = 0;
  while (current?.parentId && guard < 64) {
    const parent = map.get(current.parentId);
    if (!parent) return null;
    if (parent.type === "transformer_block") return parent;
    current = parent;
    guard += 1;
  }
  return null;
}

export function highlightFor(blueprint, componentId) {
  const componentIds = new Set();
  const connectionIds = new Set();
  const component = (blueprint.components ?? []).find((item) => item.id === componentId);
  if (!component) return { componentIds, connectionIds };

  const include = new Set([component.id]);
  if (component.type === "transformer_block") {
    const map = componentMap(blueprint);
    const stack = [component.id];
    while (stack.length) {
      const current = stack.pop();
      for (const candidate of blueprint.components ?? []) {
        if (candidate.parentId === current && !include.has(candidate.id)) {
          include.add(candidate.id);
          if (!map.has(candidate.id)) continue;
          stack.push(candidate.id);
        }
      }
    }
  }
  for (const id of include) componentIds.add(id);
  for (const connection of blueprint.connections ?? []) {
    if (include.has(connection.from) || include.has(connection.to)) {
      connectionIds.add(connection.id);
      componentIds.add(connection.from);
      componentIds.add(connection.to);
    }
  }
  return { componentIds, connectionIds };
}

function descendantsOf(blueprint, componentId) {
  const children = new Map();
  for (const component of blueprint?.components ?? []) {
    if (!component.parentId) continue;
    if (!children.has(component.parentId)) children.set(component.parentId, []);
    children.get(component.parentId).push(component);
  }
  const out = [];
  const stack = [...(children.get(componentId) ?? [])];
  while (stack.length) {
    const component = stack.pop();
    out.push(component);
    stack.push(...(children.get(component.id) ?? []));
  }
  return out;
}

export function describeSelection(blueprint, componentId) {
  const map = componentMap(blueprint);
  const component = map.get(componentId);
  if (!component) return null;
  const block = parentBlock(blueprint, component);
  const descendants = descendantsOf(blueprint, component.id);
  const aggregate = {
    components: descendants.length,
    parametersUnique: descendants.reduce((total, item) => (
      item.parameters?.counted === false ? total : total + (Number(item.parameters?.unique) || 0)
    ), 0),
    tensorElements: descendants.reduce((total, item) => (
      total + (Array.isArray(item.tensors) ? item.tensors.reduce((sum, tensor) => sum + (Number(tensor.numel) || 0), 0) : 0)
    ), 0),
    tensorCount: descendants.reduce((total, item) => total + (Array.isArray(item.tensors) ? item.tensors.length : 0), 0),
  };
  const descendantTensors = descendants.flatMap((item) => (
    Array.isArray(item.tensors)
      ? item.tensors.map((tensor) => ({ ...tensor, componentId: item.id, componentName: item.name }))
      : []
  ));
  const incoming = [];
  const outgoing = [];
  for (const connection of blueprint.connections ?? []) {
    if (connection.to === component.id) {
      const other = map.get(connection.from);
      incoming.push({
        id: connection.id,
        otherId: connection.from,
        name: other?.name ?? connection.from,
        type: connection.type,
        explicit: connection.explicit,
        inferred: connection.inferred,
        width: connection.dimensions?.width ?? null,
        note: connection.note ?? null,
      });
    }
    if (connection.from === component.id) {
      const other = map.get(connection.to);
      outgoing.push({
        id: connection.id,
        otherId: connection.to,
        name: other?.name ?? connection.to,
        type: connection.type,
        explicit: connection.explicit,
        inferred: connection.inferred,
        width: connection.dimensions?.width ?? null,
        note: connection.note ?? null,
      });
    }
  }
  const tensors = (component.tensors ?? []).map((tensor) => ({
    name: tensor.name,
    shape: Array.isArray(tensor.shape) ? [...tensor.shape] : [],
    dtype: tensor.dtype ?? null,
    elements: tensor.numel ?? null,
  }));
  return {
    component,
    block,
    blockIndex: component.blockIndex ?? block?.blockIndex ?? null,
    dimensions: { ...(component.dimensions ?? {}) },
    tensors,
    descendantTensors,
    aggregate,
    parameters: { ...(component.parameters ?? {}) },
    metadata: { ...(component.metadata ?? {}) },
    incoming,
    outgoing,
    labels: {
      derived: component.derived === true,
      inferredConnections: [...incoming, ...outgoing].filter((item) => item.inferred).length,
      tied: component.metadata?.tied === true,
    },
  };
}
