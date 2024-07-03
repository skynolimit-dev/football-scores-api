const crypto = require('crypto');

function getHash(data) {
    return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
}

module.exports = {
    getHash
}