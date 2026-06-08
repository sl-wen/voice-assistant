// qr-gen.js - Generate QR code PNG for SoundBridge
// Usage: node qr-gen.js <url> <output_path>
const QR = require('qrcode');
const url = process.argv[2];
const out = process.argv[3];
if (!url || !out) { process.exit(1); }
QR.toFile(out, url, {
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 120,
  color: { dark: '#1E1E32', light: '#FFFFFF' }
}, (err) => { process.exit(err ? 1 : 0); });
