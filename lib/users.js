const _ = require('lodash');
const db = require('./db');


// Returns the user info for the given user (device) ID
async function get(deviceId) {
    return await db.get('users', deviceId);
}

// Updates the user and device info for the given user (device) ID
async function set(globals, userDeviceInfo, deviceId) {
    // Do a deep comparison of the user info object with the cached user info object 
    // to determine whether the user info has changed
    // Only update the DB if the user info has changed
    let cachedUserInfo = globals.data.cache.userInfo[deviceId];
    // Remove transient timestamps
    userDeviceInfo = _.omit(userDeviceInfo, 'notificationsRegistration.token.registerTime');
    cachedUserInfo = _.omit(cachedUserInfo, 'notificationsRegistration.token.registerTime');
    cachedUserInfo = _.omit(cachedUserInfo, 'lastUpdated');
    userDeviceInfo = _.omit(userDeviceInfo, 'lastUpdated');
    _.set(userDeviceInfo, 'device.info', getFilteredDeviceInfo(userDeviceInfo.device.info));
    // Only update the DB if the user info has changed
    // or if the user has registered for notifications and we don't have a token stored in the DB
    if (
        (!cachedUserInfo && isDeepEqual(userDeviceInfo, cachedUserInfo)) ||
        (_.get(userDeviceInfo, 'notificationsRegistration.token.value') && !_.get(cachedUserInfo, 'notificationsRegistration.token.value'))
    ) {
        console.log('User info updated:', deviceId);
        userDeviceInfo.lastUpdated = new Date().toISOString();
        _.set(globals.data.cache.userInfo, deviceId, userDeviceInfo);
        return await db.set('users', deviceId, userDeviceInfo);
    }

    return true;
}

function getFilteredDeviceInfo(deviceInfo) {
    return _.pick(deviceInfo, [
        'iOSVersion',
        'webViewVersion',
        'operatingSystem',
        'platform',
        'manufacturer',
        'osVersion',
        'name',
        'model',
        'isVirtual'
    ]);
}

const isDeepEqual = (object1, object2) => {

    const keysToIgnore = [
        'notificationsRegistration',
        'registerTime',
        'registerReady'
    ];

    const objKeys1 = Object.keys(object1);
    const objKeys2 = Object.keys(object2);

    if (objKeys1.length !== objKeys2.length) return false;

    for (var key of objKeys1) {
        if (keysToIgnore.includes(key)) continue;
        const value1 = object1[key];
        const value2 = object2[key];

        const isObjects = isObject(value1) && isObject(value2);

        if ((isObjects && !isDeepEqual(value1, value2)) ||
            (!isObjects && value1 !== value2)
        ) {
            console.log('Updated:', key);
            console.log(value1);
            console.log(value2);
            return false;
        }
    }
    return true;
};

const isObject = (object) => {
    return object != null && typeof object === "object";
};

// Updates the user preferences for the given user (device) ID
async function setPreferences(globals, preferences, deviceId) {
    // Do a deep comparison of the preferences object with the cached preferences object 
    // to determine whether the preferences have changed
    // Only update the DB if the preferences have changed
    let cachedPreferences = globals.data.cache.userPreferences[deviceId];
    cachedPreferences = _.omit(cachedPreferences, 'lastUpdated');
    preferences = _.omit(preferences, 'lastUpdated');
    if (cachedPreferences && isDeepEqual(preferences, cachedPreferences)) {
        return true;
    }
    else {
        console.info('Preferences updated:', deviceId);
        preferences.lastUpdated = new Date().toISOString();
        _.set(globals.data.cache.userPreferences, deviceId, preferences);
        return await db.set('preferences', deviceId, preferences);
    }
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
    getAll
}