const { verifyToken } = require('./src/auth');

const token = 'orbit_test_owner_token_1234567890abcdefghijklmnop';
console.log('Testing token:', token);

const user = verifyToken(token);
console.log('Verification result:', user);
