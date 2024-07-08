const _ = require('lodash');
const db = require('./db');


// Watch the user preferences collection for changes
function initUserPreferencesWatcher(globals, setMatchesOfInterestForUser) {
    const query = db.db.collection('preferences');
    userPreferencesWatcher = query.onSnapshot(querySnapshot => {
        querySnapshot.docChanges().forEach(change => {
            const deviceId = change.doc.id;
            const preferences = change.doc.data();
            _.set(globals.data.userPreferencesCache, deviceId, preferences);
            // Set the interested users for matches
            setMatchesOfInterestForUser(globals, deviceId, preferences);
        }
    )}, err => {
        console.error(`Encountered error setting up user preferences watcher: ${err}`);
    });
}


// Returns the user info for the given user (device) ID
async function get(deviceId) {
    return await db.get('users', deviceId);
}

// Updates the user and device info for the given user (device) ID
async function set(userDeviceInfo, deviceId) {
    return await db.set('users', deviceId, userDeviceInfo);
}

// Updates the user preferences for the given user (device) ID
async function setPreferences(preferences, deviceId) {
    return await db.set('preferences', deviceId, preferences);
}

// Gets the given preference for the given user
async function getPreference(deviceId, preference) {
    try {
        const preferences = await getPreferences(deviceId);
        return _.get(preferences, preference);
    } catch (error) {
        console.error('Error getting user preferences: ', error);
    }
}

// Gets the preferences for the given user (device) ID
async function getPreferences(deviceId) {
    return await db.get('preferences', deviceId);
}

// Deletes the user data for the given device ID
function deleteData(globals, deviceId) {
    // Delete the object for the user, and return true if successful
    try {
        const userIndex = getIndex(globals, deviceId);    
        globals.data.users.splice(userIndex, 1);
        return {
            success: true
        }
    } catch (error) {
        return {
            success: false,
            error: error
        }
    }
}

// Returns true if the user data exists for the given device ID (in the "globals.data.users" array)
function getIndex(globals, deviceId) {
    // Find the index of the user data in the globals.data.users array where the userDeviceInfo.id attribute matches deviceId
    return _.findIndex(globals.data.users, { 'id': deviceId });
}

// Returns an array of all users
async function getAll() {
    const users = await db.getAll('users');
    return users && users.length > 0 ? users : [];
}


module.exports = {
    deleteData,
    get,
    set,
    setPreferences,
    getPreference,
    getAll,
    initUserPreferencesWatcher
}