import fs from 'fs';
const content = fs.readFileSync('E:/Development/Repositories/SimpleMindsAI/src/admin/routes.js', 'utf8');
const idx = content.indexOf('/domains", asyncRoute(async (req, res) => {');
if (idx >= 0) {
  const endIdx = content.indexOf('const limit = Number(limit) || 100;', idx);
  if (endIdx >= 0) {
    const oldStr = content.substring(idx, idx + 500);
    const newStr = oldStr.replace('const { policy, origin, after, limit } = req.query;', 'const { policy, origin, after, limit: limitParam } = req.query;')
      .replace('const limit = Number(limit) || 100;', 'const limit = Number(limitParam) || 100;');
    
    const newContent = content.substring(0, idx) + newStr + content.substring(idx + oldStr.length);
    fs.writeFileSync('E:/Development/Repositories/SimpleMindsAI/src/admin/routes.js', newContent);
    console.log('Fixed');
  } else {
    console.log('Could not find limit declaration');
  }
} else {
  console.log('Could not find /domains route');
}