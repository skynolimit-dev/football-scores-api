const apn = require('node-apn');
const path = require('path');

const keyPath = path.resolve(__dirname, '../.keys/AuthKey_MKW2N982MT.p8');

// TODO: Use secrets
const options = {
    token: {
        key: keyPath, // Path to your APNs private key file
        keyId: 'MKW2N982MT', // Key ID obtained from Apple Developer Portal
        teamId: 'SJ8X4DLAN9' // Team ID obtained from Apple Developer Portal
    },
    production: process.env.NODE_ENV === 'production' ? true : false

};

console.log('APN options - production:', options.production);

// Initialise and return a new APN provider
// This is called by server.js to pass in when sending notifications to iOS devices
function getProvider() {
    let provider = null;
    try {
        provider = new apn.Provider(options);
    } catch (error) {
        console.error('Error creating APN provider: ', error);
    }
    return provider;
}

module.exports = {
    getProvider
}