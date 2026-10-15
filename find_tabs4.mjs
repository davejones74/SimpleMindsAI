import fs from 'fs';
const content = fs.readFileSync('E:/Development/Repositories/SimpleMindsAI/src/admin/public/app.js', 'utf8');
const idx = content.indexOf('id="tabs"');
if (idx >= 0) {
  console.log('Found at:', idx);
  console.log(content.substring(idx - 200, idx + 500));
}