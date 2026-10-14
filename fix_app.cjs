const fs = require('fs');
const content = fs.readFileSync('E:/Development/Repositories/SimpleMindsAI/src/admin/public/app.js', 'utf8');
const idx = content.indexOf('const esc = (v)');
if (idx >= 0) {
  const end = content.indexOf('\nconst fmt', idx);
  const oldStr = content.substring(idx - 3, end + 1);
  
  const newStr = oldStr.replace('const esc', '/** Restore the selected job from URL hash if it exists in the current job list. */\nfunction restoreJobFromHashIfValid() {\n  const jobId = readJobHash();\n  if (!jobId) return;\n  // Check if the job still exists in the current job list\n  const jobExists = document.querySelector(`[data-job="${esc(jobId)}"]`);\n  if (jobExists) {\n    state.openJobId = jobId;\n    openJob(jobId, { silent: true });\n  } else {\n    // Job no longer exists - clear the hash\n    writeJobHash(null);\n  }\n}\n\nconst esc');
  
  const newContent = content.substring(0, idx - 3) + newStr + content.substring(end + 1);
  fs.writeFileSync('E:/Development/Repositories/SimpleMindsAI/src/admin/public/app.js', newContent);
  console.log('File updated successfully');
}