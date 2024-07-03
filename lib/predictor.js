const _ = require('lodash');
const notifications = require('./notifications');

const Introspected = require('introspected');

const users = require('./users');
const utils = require('./utils');

let cleanupTimeout = null;

// Initialises the given match
function initMatch(globals, predictorDetails) {
    try {
        const matchId = _.get(predictorDetails, 'matchId');
        const deviceId = _.get(predictorDetails, 'device.id');

        // Extract the date from the match ID, which should be the first 10 characters
        // before the first underscore (e.g. "2021-06-11_21:00_Chelsea-Tottenham" -> "2021-06-11)
        const date = matchId.split('_')[0];
        let match = _.find(globals.data.matches, { id: matchId });

        if (matchId && deviceId && match) {
            createMatch(globals, deviceId, match, predictorDetails);
            const predictorMatch = getMatch(globals, deviceId, matchId);
            kickOffMatch(deviceId, predictorMatch);
            updateMatch(globals, predictorMatch, predictorDetails);
            return { success: true };

        } else {
            console.error('Invalid predictor details:', predictorDetails);
            return { success: false, error: 'Invalid predictor details' };
        }
    } catch (error) {
        console.error('Error initialising predictor match:', error);
        return { success: false, error: error };
    } finally {
        cleanUpOldMatches(globals);
    }
}

// Cleans up old predictor matches more than 1 day old
function cleanUpOldMatches(globals) {

    console.info('Cleaning up old predictor matches');

    const predictorMatches = _.get(globals, 'data.predictorMatches', {});

    // For each device under predictorMatches (i.e. globals.data.predictorMatches[deviceId]),
    // remove any matches that started or finished more than 1 day ago
    for (const [deviceId, value] of Object.entries(predictorMatches)) {
        const matches = _.get(predictorMatches, deviceId);
        if (matches && matches.length > 0) {
            _.remove(matches, match => {
                const finishedTime = _.get(match, 'predictorDetails.finishedTime');
                const startedTime = _.get(match, 'predictorDetails.startedTime');
                const now = new Date().getTime();
                return (finishedTime && (now - new Date(finishedTime).getTime() > 24 * 60 * 60 * 1000)) || (startedTime && (now - new Date(startedTime).getTime() > 24 * 60 * 60 * 1000));
            });
        }
    }

    // Repeat every 30 minutes
    if (cleanupTimeout)
        clearTimeout(cleanupTimeout);
    cleanupTimeout = setTimeout(() => {
        cleanUpOldMatches(globals);
    }, 30 * 60 * 1000);

}

// Create a match proxy object for the given match info
// This is so that any updates (e.g. score changes) can be tracked for sending out notifications
function createMatchProxy(globals, matchInfo) {
    return Introspected(
        matchInfo,
        (match, path) => {
            notifications.processMatchUpdate(globals, match, path);
        }
    );
}

// Pauses the given match
function pauseMatch(globals, predictorDetails) {
    try {
        const matchId = _.get(predictorDetails, 'matchId');
        const deviceId = _.get(predictorDetails, 'device.id');

        if (matchId && deviceId) {
            const match = getMatch(globals, deviceId, matchId);
            if (match) {
                _.set(match, 'predictorDetails.status', 'paused');
                _.set(match, 'timeLabel', 'P');
            }
            return { success: true };

        } else {
            console.error('Invalid predictor details:', predictorDetails);
            return { success: false, error: 'Invalid predictor details' };
        }
    } catch (error) {
        console.error('Error pausing predictor match:', error);
        return { success: false, error: error };
    }
}

// Pauses the given match
function resumeMatch(globals, predictorDetails) {

    try {
        const matchId = _.get(predictorDetails, 'matchId');
        const deviceId = _.get(predictorDetails, 'device.id');

        if (matchId && deviceId) {
            const match = getMatch(globals, deviceId, matchId);
            if (match) {
                _.set(match, 'predictorDetails.status', 'started');
                updateMatch(globals, match, predictorDetails);
            }
            return { success: true };

        } else {
            console.error('Invalid predictor details:', predictorDetails);
            return { success: false, error: 'Invalid predictor details' };
        }
    } catch (error) {
        console.error('Error pausing predictor match:', error);
        return { success: false, error: error };
    }
}

// Create the predictor match (and array if not already present) for the given device and match ID
function createMatch(globals, deviceId, match) {
    const predictorMatches = _.get(globals, `data.predictorMatches.${deviceId}`);
    // Create the array if it doesn't already exist
    if (!predictorMatches)
        _.set(globals, `data.predictorMatches.${deviceId}`, []);
    // Delete any existing data for the same match if it exists
    else
        deleteExistingMatchData(globals, deviceId, match);

    // Clone the match (to avoid the original match getting overwritten)
    let matchClone = JSON.parse(JSON.stringify(match));

    // Then, expand the JSON
    matchClone = utils.getJsonExpanded(matchClone);

    // Add the match to the predictor matches array
    globals.data.predictorMatches[deviceId].push(createMatchProxy(globals, matchClone));
}

// Deletes any existing predictor matches for the given match and device ID from the matchesInPlay array
function deleteExistingMatchData(globals, deviceId, match) {

    // Delete any existing match in play with the same match ID and predictor device ID
    const matchInPlay = _.find(globals.data.matchesInPlay, { id: match.id, predictorDetails: { deviceId: deviceId } });
    if (matchInPlay) {
        console.info(`Deleting existing predictor match in play ${match.id} for device ${deviceId}`);
        _.pull(globals.data.matchesInPlay, match);
    }

    // Delete any existing predictor match with the same match ID and predictor device ID
    const predictorMatch = _.find(globals.data.predictorMatches[deviceId], { id: match.id });
    if (predictorMatch) {
        console.info(`Deleting existing predictor match ${match.id} for device ${deviceId}`);
        _.pull(globals.data.predictorMatches[deviceId], predictorMatch);
    }

}

// Kick off the given match for the given device ID
function kickOffMatch(deviceId, match) {
    console.info(`Kicking off predictor match ${match.id} for device ${deviceId}`);
    const predictorDetails = {
        deviceId: deviceId,
        status: 'started',
        startedTime: new Date().toISOString()
    }
    // _.set(match, 'dateTimeUtc', new Date().toISOString());
    _.set(match, 'predictorDetails', predictorDetails);
    _.set(match, 'time', 1);
    _.set(match, 'homeTeam.score', 0);
    _.set(match, 'awayTeam.score', 0);
}

// Gets the time label for the match time
// e.g. 10 -> 10'
function getTimeLabel(time) {
    return `${time}'`;
}

// Updates the given match for the given device ID
// Increases the match time, updates scores etc
async function updateMatch(globals, match, predictorDetails) {

    // Unless the game is paused, update the match time, score and status messages
    if (match.predictorDetails.status !== 'paused') {
        updateMatchTime(match);
        updateMatchScore(globals, match);
        updateMatchStatusMessages(match);
    }

    // Unless the match has ended or is paused, call updateMatch again after a delay
    const refreshInterval = await getRefreshInterval(globals, predictorDetails);
    if (match.predictorDetails.status !== 'stopped' && match.timeLabel !== 'FT' && match.timeLabel !== 'AET') {
        setTimeout(() => {
            updateMatch(globals, match, predictorDetails);
        }, refreshInterval);
    } else {
        finishMatch(globals, match, predictorDetails);
    }

    // Sync any changes back to the predictor match so that it reflects in the app
    const predictorMatch = _.find(globals.data.predictorMatches[predictorDetails.device.id], { id: match.id });
    _.set(predictorMatch, 'time', match.time);
    _.set(predictorMatch, 'timeLabel', match.timeLabel);
    _.set(predictorMatch, 'homeTeam.score', match.homeTeam.score);
    _.set(predictorMatch, 'awayTeam.score', match.awayTeam.score);
    _.set(predictorMatch, 'statusMessages', match.statusMessages);

}

// Finishes the give match for the given device ID
function finishMatch(globals, match, predictorDetails) {
    _.set(predictorDetails, 'status', 'finished');
    _.set(predictorDetails, 'finishedTime', new Date().toISOString());
    _.set(match, 'predictorDetails', predictorDetails);

    // If the scores are level and the competition subheading is 'Final', add extra time
    if (match.homeTeam.score === match.awayTeam.score && match.competition.subHeading === 'Final')
        match.statusMessages.push(getPenaltyWinnerLabel(match));
}

// Returns the label for the penalty winner, which is decided at random
function getPenaltyWinnerLabel(match) {
    const winner = Math.random() < 0.5 ? match.homeTeam.names.displayName : match.awayTeam.names.displayName;
    return `Predicted penalty shoot-out winner: ${winner}`;
}

// Returns the match update refresh interval
async function getRefreshInterval(globals, predictorDetails) {

    // Get the default value from the config, or use supersonic by default
    let refreshInterval = _.get(globals, 'config.predictor.defaults.refreshIntervalMilliseconds') || 1;

    const predictorSpeedPreference = await users.getPreference(predictorDetails.device.id, 'predictor.speed');
    if (predictorSpeedPreference)
        refreshInterval = _.get(globals, `config.predictor.defaults.refreshIntervalMilliseconds[${predictorSpeedPreference}]`) || refreshInterval;

    // Return the refresh interval for the preferred speed, otherwise the default
    return refreshInterval;
}

// Increases the match time
// TODO (future enhancement): Handle HT, injury time etc
function updateMatchTime(match) {
    if (match.time < 90) {
        _.set(match, 'time', match.time + 1);
        _.set(match, 'timeLabel', getTimeLabel(match.time));
    }
    else {
        console.log('******************* FULL TIME *******************')
        _.set(match, 'time', 90);
        _.set(match, 'timeLabel', 'FT');
        _.set(match, 'statusMessages', ['FT']);
    }
}

// Update the match score
function updateMatchScore(globals, match) {
    match.homeTeam.score += updateScoreForTeam(globals, match.homeTeam, match.awayTeam);
    match.awayTeam.score += updateScoreForTeam(globals, match.awayTeam, match.homeTeam);
}

// Updates the score for the given team
// Based on the teams respective ratings, calculate the chances of a goal being scored for the team
// The higher the difference between the ratings, the more chance of a goal being scored
// This function will be called approximately once every match minute, i.e. 90 times per match
// Generally, teams tend to score a maximum of 2 or 3 goals per match, although this can vary
// depending on the teams' ratings and the match circumstances
function updateScoreForTeam(globals, team1, team2) {
    const ratingPercentDifference = (100 - ((team2.rating / team1.rating) * 100)) * globals.config.predictor.defaults.teamRatingDifferential;
    // console.debug('Rating percent difference for', team1.names.displayName, ':', ratingPercentDifference);
    const goalChance = globals.config.predictor.defaults.goalChancePerMinute + ((ratingPercentDifference / 100) * globals.config.predictor.defaults.goalChancePerMinute);   // Add on the percentage difference
    // console.debug('Goal chance for', team1.names.displayName, '(', team1.rating, '):', goalChance);
    const scoreIncrement = Math.random() < goalChance ? 1 : 0;
    // if (scoreIncrement > 0)
    // console.debug(` ************ GOAL for ${team1.names.displayName}: ${scoreIncrement} ***************`);
    return scoreIncrement;
}

// Update the status messages for the match (e.g. "30 mins", "HT", "FT")
// TODO (future enhancement): Handle HT, injury time etc
function updateMatchStatusMessages(match) {
    if (match.time < 90)
        _.set(match, 'statusMessages', [getTimeLabel(match.time)]);
    else
        _.set(match, 'statusMessages', ['FT']);
}

// Gets the predictor match for the given device and match ID
function getMatch(globals, deviceId, matchId) {
    const predictorMatches = _.get(globals, `data.predictorMatches.${deviceId}`);
    if (predictorMatches && predictorMatches.length > 0)
        return _.find(globals.data.predictorMatches[deviceId], { id: matchId });
}

module.exports = {
    initMatch,
    getMatch,
    pauseMatch,
    resumeMatch
}