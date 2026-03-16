const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', 'public', 'js');
const OUT_DIR = path.join(__dirname, '..', 'public', 'js-min');

// Ensure output directory exists
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Get all JS files in public/js/
const jsFiles = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js'));

let totalOriginal = 0;
let totalMinified = 0;

for (const file of jsFiles) {
  const input = path.join(JS_DIR, file);
  const output = path.join(OUT_DIR, file);

  try {
    const result = esbuild.buildSync({
      entryPoints: [input],
      outfile: output,
      minify: true,
      bundle: false,  // Don't bundle, just minify each file
      target: ['es2020'],
      charset: 'utf8',
    });

    const origSize = fs.statSync(input).size;
    const minSize = fs.statSync(output).size;
    totalOriginal += origSize;
    totalMinified += minSize;

    const savings = ((1 - minSize / origSize) * 100).toFixed(1);
    if (savings > 20) {
      console.log(`  ${file}: ${(origSize/1024).toFixed(1)}KB → ${(minSize/1024).toFixed(1)}KB (-${savings}%)`);
    }
  } catch (e) {
    // If minification fails, just copy the original
    fs.copyFileSync(input, output);
    console.warn(`  ${file}: minification failed, copied original`);
  }
}

console.log(`\nTotal: ${(totalOriginal/1024).toFixed(0)}KB → ${(totalMinified/1024).toFixed(0)}KB (-${((1-totalMinified/totalOriginal)*100).toFixed(1)}%)`);
