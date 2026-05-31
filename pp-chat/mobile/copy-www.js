const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'src');
const dest = path.join(__dirname, 'www');

if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

for (const file of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
}

console.log('www/ updated from src/');
