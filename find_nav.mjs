import fs from 'fs';
const content = fs.readFileSync('E:/Development/Repositories/SimpleMindsAI/src/admin/public/app.js', 'utf8');
const idx = content.indexOf('<nav id="tabs"');
if (idx >= 0) {
  console.log('Found at:', idx);
  console.log(content.substring(idx, idx + 500));
} else {
  console.log('Not found');
}