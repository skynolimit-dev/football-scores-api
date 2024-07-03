const apn = require('@parse/node-apn');
const _ = require('lodash');

const hashing = require('./hashing');
const apnProvider = require('./apnNotifications').getProvider();
const db = require('./db');
const users = require('./users');

// Processes the given match update to determine whether a notification should be sent
// We only want to send notifications for certain types of updates, e.g. score changes and half/full time
function processMatchUpdate(globals, match, updatePath) {

  // If the update path includes a double underscore, split it so it becomes an array
  if (updatePath && updatePath[0]) {
    if (updatePath[0].includes('__'))
      updatePath = updatePath[0].split('__');

    // console.log('Processing match update: ', updatePath, match.id);
    if (updatePath.includes('score'))
      processScoreUpdate(globals, match, updatePath);
    else if (updatePath.includes('timeLabel'))
      processTimeUpdate(globals, match);
    else if (updatePath.includes('started'))
      processKickOffUpdate(globals, match);
  }
}

// Processes a kick off update for the given match
function processKickOffUpdate(globals, match) {
  console.log('Processing started update for match: ', match.id, match.started);
  if (match.started) {
    const ttl = _.get(globals, 'config.notifications.matchUpdateTtlSeconds', 86400);
    const message = {
      title: 'Kick off!',
      body: `Match started: ${match.homeTeam.names.displayName} vs ${match.awayTeam.names.displayName}`,
      type: 'kick_off'
    };
    send(globals, match, message, ttl);
  }
}

// Processes a score update for the given match
// The first element of the updatePath array should be "homeTeam" or "awayTeam",
// allowing us to work out who scored and send a goal update notification
function processScoreUpdate(globals, match, updatePath) {
  console.log('Processing score update for match: ', match.id, updatePath);
  const goalCount = _.get(match, `${updatePath[0]}.score`);
  const ttl = _.get(globals, 'config.notifications.matchUpdateTtlSeconds', 86400);
  // Set the time label (note that we don't get this for every match, so it may be null)
  let timeLabel = _.get(match, 'timeLabel');
  timeLabel = timeLabel ? `(${timeLabel})` : '';
  const scoringTeamName = _.get(match, `${updatePath[0]}.names.displayName`);
  const message = {
    title: `Goal update: ${scoringTeamName}`,
    body: `${scoringTeamName === match.homeTeam.names.displayName ? '⚽️ ' : ''}${match.homeTeam.names.displayName}  ${match.homeTeam.score} - ${match.awayTeam.score}  ${match.awayTeam.names.displayName} ${scoringTeamName === match.awayTeam.names.displayName ? '⚽️' : ''} ${timeLabel}\n${getCompetitionLabel(match)}`,
    type: 'score_updates'
  };
  send(globals, match, message, ttl);
}


function getCompetitionLabel(match) {
  const competitionName = _.get(match, 'competition.name');
  const competitionSubHeading = _.get(match, 'competition.subHeading');
  return competitionSubHeading ? `${competitionName} - ${competitionSubHeading}` : competitionName;
}

// Processes a time update for the given match
// If it's half time (HT), full time (FT) or after extra time (AET), send a notification
function processTimeUpdate(globals, match) {
  // console.log('Processing time update for match: ', match.id);
  const timeLabel = _.get(match, 'timeLabel');
  const ttl = _.get(globals, 'config.notifications.matchUpdateTtlSeconds', 86400);

  let titlePrefix = null;
  let type = null;

  const titleSuffix = `${match.homeTeam.names.displayName}  ${match.homeTeam.score} - ${match.awayTeam.score}  ${match.awayTeam.names.displayName}`

  if (timeLabel === 'HT') {
    titlePrefix = '🕒 Half time';
    type = 'half_time';
  }
  else if (timeLabel === 'FT') {
    titlePrefix = '🕒 Full time';
    type = 'full_time';
  }
  else if (timeLabel === 'AET') {
    titlePrefix = '🕒 Extra time finished';
    type = 'full_time';
  }
  if (titlePrefix && type) {
    console.log('Sending time update notification for match: ', titlePrefix, match.id);
    const message = {
      title: `${titlePrefix}: ${titleSuffix}`,
      body: getCompetitionLabel(match),
      type: type
    }
    send(globals, match, message, ttl);
  }
}

// Main function to send a notification to all eligible devices
// Iterates through all users and for each user, checks the following...
// 1. The device has a push notification token registered
// 2. The user wishes to receive notifications for the given message category (message.type) in their preferences
// 3. TODO: The user has not already received a notification for the given message (message.id)
// If all conditions are met, the notification is sent to the user's device
async function send(globals, match, message, ttl) {

  console.log(' -- About to send message for match: ', match.id, message);
  console.log(' -- Interested users: ', match.interestedUsers);

  // Array to store the device IDs of all recipients
  let recipientDeviceIds = [];

  // Iterate through all users
  for (const user of await users.getAll()) {

    console.log(' -- Checking user: ', user.id);

    // If it's a real match and the user is interested in receiving notifications for it,
    // or it is a predictor match and the user ID matches the predictor recipient device ID,
    // then check the user's preferences to see whether they should be sent a notification
    if (match.interestedUsers.includes(user.id)) {

      // const registerReady = _.get(user, 'notificationsRegistration.registerReady');
      const token = _.get(user, 'notificationsRegistration.token.value');

      console.log(' -- Checking user: ', user.id, token);

      // Check if the user has registered for notifications, i.e. they have a push notification token
      if (token) {

        console.log(' -- User is registered for notifications and has a token: ', user.id);

        // Get the user preferences for the given device ID
        const preferences = _.get(globals.data.userPreferencesCache, user.id);

        // Check if the user has enabled notifications for the given message type
        if (_.get(preferences, `notifications.options.${message.type}`, false)) {
          console.log(` -- User ${user.id} has enabled notifications for message type: `, message.type);
          recipientDeviceIds.push(user.id);
        } else {
          console.log(` -- !! User ${user.id} has NOT enabled notifications for message type: `, message.type, user);
        }
      }

    }
  }

  sendToDevices(globals, message, recipientDeviceIds, match.id, ttl);

}

async function getUserNotificationDetails(globals, deviceId) {

  const [user, notificationsSpeedPreference] = await Promise.all([users.get(deviceId), users.getPreference(deviceId, 'notifications.speed')]);
  const token = _.get(user, 'notificationsRegistration.token.value');
  const delay = _.get(globals, `config.notifications.sendDelaysMilliseconds.${notificationsSpeedPreference}`, 5000)

  return {
    user: user,
    token: token || '*** NOT SET ***',
    notificationsSpeedPreference: notificationsSpeedPreference,
    delay: delay
  }
}

async function sendToDevices(globals, message, recipientDeviceIds, threadId, ttl) {

  const notification = new apn.Notification({
    alert: message, // Notification message
    threadId: threadId, // Thread ID (normally the match ID)
    sound: 'default', // Notification sound
    topic: 'topscores.dev.skynolimit', // Bundle ID 
  });

  // Iterate through the device IDs and send the notification to each device
  // We retrieve the user's notification speed preference first to set
  // the appropriate delay value
  for (const deviceId of recipientDeviceIds) {
    const [user, notificationsSpeedPreference] = await Promise.all([users.get(deviceId), users.getPreference(deviceId, 'notifications.speed')]);
    const token = _.get(user, 'notificationsRegistration.token.value');
    const delay = _.get(globals, `config.notifications.sendDelaysMilliseconds.${notificationsSpeedPreference}`, 5000)

    if (token) {
      console.log('>>> Sending message to device: ', deviceId, ' with delay: ', delay, ' and token: ', token);
      setTimeout(() => {
        sendToDevice(notification, deviceId, token, threadId, ttl);
      }, delay);
    }
    else {
      console.log('Device token not set, so unable to send message to device: ', deviceId);
    }
  }

}


// Sends the given notification to the given device
// Note that we send to individual devices to allow for per-user delay preferences
async function sendToDevice(notification, deviceId, token, threadId, ttl) {

  // Sleep a random amount of time between 0 and 500 milliseconds to prevent a race condition
  // if multiple app servers are attempting to send a notification at the same time
  await new Promise(resolve => setTimeout(resolve, Math.random() * 500));

  // Set the notification ID to be the thread ID + device ID + hash of the notification
  const notificationId = `${deviceId}-${threadId}-${hashing.getHash(notification)}`;

  if (!await db.get('notifications', notificationId)) {

    // Set a notification hash to prevent duplicate notifications
    await db.set('notifications', notificationId, { sent: true });

    console.log('Sending message to device: ', deviceId, ' with token: ', token, 'and ID:', notificationId);

    // Generate a notification entry to store in the DB
    let notificationEntry = {
      notification: notification,
      deviceId: deviceId,
      token: token,
      time: new Date().toISOString(),
      succeeded: false
    }

    let response = null;

    try {
      response = await apnProvider.send(notification, token);
    } catch (error) {
      console.error('Error sending notification: ', error);
      _.set(notificationEntry, 'error', error);
    }

    if (!response || (response.failed && response.failed.length > 0)) {
      console.error('Notification not sent successfully to: ', deviceId);
      const errorResponse = _.get(response, 'error.response.failed[0].response', 'Unknown error');
      _.set(notificationEntry, 'failureResponse', errorResponse);
      console.error(JSON.stringify(errorResponse));
    }
    else {
      _.set(notificationEntry, 'succeeded', true);
      console.info('Notification sent successfully to: ', deviceId);
    }

    // Store the notification entry in the DB
    await db.set('notifications', notificationId, notificationEntry);
    console.debug('Notification entry: ', JSON.stringify(notificationEntry, 2));
    return notificationEntry.succeeded;

  } else {
    console.log('Notification already sent: ', notificationId);
    return false;
  }

}

// Sends a test notification to the given device
async function sendTestNotification(deviceId) {

  const user = await users.get(deviceId);
  const deviceToken = _.get(user, 'notificationsRegistration.token.value');

  console.log('Sending test notification to device: ', deviceId, ' with token: ', deviceToken);

  let succeeded = false;

  if (deviceToken) {
    const notification = new apn.Notification({
      alert: `Test notification generated at ${new Date().toISOString()}`, // Notification message
      threadId: 'test_notification', // Thread ID (normally the match ID)
      sound: 'default', // Notification sound
      topic: 'topscores.dev.skynolimit', // Bundle ID 
    });
    succeeded = await sendToDevice(notification, deviceId, deviceToken, 'test_notification', 86400);
  }

  return succeeded;

}

// Sends a notification to indicate that the server has started
// TODO: Move device ID and token to secrets
async function sendServerStartupNotification() {

  const deviceId = 'D1B468E9-AC32-42C1-BB83-B7B60D3DA094';
  const user = await users.get(deviceId);
  const deviceToken = _.get(user, 'notificationsRegistration.token.value');

  const hostname = require('os').hostname();
  const nodeEnvironment = process.env.NODE_ENV;

  // Get the current time in format HH:mm:ss
  const time = new Date().toLocaleTimeString();

  const message = {
    title: '⚽️ Server started!',
    subtitle: `Football scores API server started at ${time}! 🚀`,
    body: `Server: ${hostname} \nNode environment: ${nodeEnvironment}`,
    type: 'server_start'
  };

  let notification = new apn.Notification({
    alert: message, // Notification message
    threadId: 'server_start', // Thread ID (normally the match ID)
    sound: 'default', // Notification sound
    topic: 'topscores.dev.skynolimit', // Bundle ID 
  });

  const ttl = 86400; // 24 hours
  sendToDevice(notification, deviceId, deviceToken, 'server_start', ttl);

}

module.exports = {
  processMatchUpdate,
  send,
  sendServerStartupNotification,
  sendTestNotification,
  getUserNotificationDetails
};