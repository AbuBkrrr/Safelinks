const os = require('os');
const crypto = require('crypto');
const https = require('https');

function getHardwareFingerprint() {
    const cpus = os.cpus().map(c => c.model).join('');
    const mac = Object.values(os.networkInterfaces())
        .flat()
        .find(i => !i.internal && i.mac !== '00:00:00:00:00:00')?.mac || 'no-mac';
    const raw = `${os.hostname()}-${cpus}-${mac}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
}

async function validateLicense(licenseKey) {
    return new Promise((resolve, reject) => {
        const fingerprint = getHardwareFingerprint();
        const data = JSON.stringify({ key: licenseKey, fingerprint });

        const options = {
            hostname: process.env.LICENSE_SERVER_URL || 'your-license-server.com',
            port: 443,
            path: '/api/license/validate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(body);
                    resolve(response.valid);
                } catch {
                    resolve(false);
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function licenseMiddleware(req, res, next) {
    const licenseKey = process.env.SAFE_LINKS_LICENSE_KEY;
    if (!licenseKey) {
        return res.status(403).json({ error: 'No license key configured.' });
    }
    try {
        const isValid = await validateLicense(licenseKey);
        if (!isValid) {
            return res.status(403).json({ error: 'License invalid or expired.' });
        }
    } catch (err) {
        // Allow offline operation if server is unreachable
        console.warn('License server unreachable, continuing in offline mode.');
    }
    next();
}

module.exports = { validateLicense, licenseMiddleware, getHardwareFingerprint };
