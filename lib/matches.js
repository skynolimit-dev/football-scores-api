const axios = require('axios');
axios.defaults.timeout = 10000;
axios.defaults.headers = {
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Expires': '0',
};

const cheerio = require('cheerio');
const moment = require('moment');
const Introspected = require('introspected');
const _ = require('lodash');

const db = require('./db');
const notifications = require('./notifications');
const utils = require('./utils');

let timeouts = {};
let matchWatcher = null;

// Sets the interestedUsers array for the given match
// Triggered whenever a new match is added to the DB
function setInterestedUsersForMatch(globals, matchId) {
    const match = getMatchById(globals, matchId);
    if (match) {
        for (const user of globals.data.users)
            setMatchOfInterestToUser(globals, match, user.id);
    }
}


// Set the matches of interest for the given user
// This is what determines what fixtures/results are shown to the user, and
// what notifications they receive
function setMatchesOfInterestForUser(globals, deviceId) {
    for (const match of globals.data.matches) {
        setMatchOfInterestToUser(globals, match, deviceId);
    }
}

// Adds or removes the user from the match's interestedUsers array
// This is what determines whether the user sees results/fixtures/notifications for the match
function setMatchOfInterestToUser(globals, match, deviceId) {

    const competitionsOfInterest = getCompetitionsOfInterestForUser(globals, deviceId);
    const teamsOfInterest = getTeamsOfInterestForUser(globals, deviceId);

    // Then add the user to the match's interestedUsers array if the match is of interest to the user
    if (isMatchOfInterestToUser(globals, match, competitionsOfInterest, teamsOfInterest)) {
        // console.log('Match is of interest to user:', match.id, deviceId);
        if (!match.interestedUsers.includes(deviceId))
            match.interestedUsers.push(deviceId);
    }
    else {
        if (match.interestedUsers.includes(deviceId)) {
            // console.log('Match is no longer of interest to user:', match.id, deviceId);
            match.interestedUsers = match.interestedUsers.filter(user => user !== deviceId);
        }
    }
}

// Get the competitions of interest for the given user
function getCompetitionsOfInterestForUser(globals, deviceId) {
    // If it's not "default" (used by the widget), get the user's preferences
    if (deviceId !== 'default') {
        const preferences = _.get(globals.data.userPreferencesCache, deviceId);
        return _.get(preferences, 'competitions', []);
    }
    // Otherwise, return the leagues from globals.data.leagues where isDefault is true
    else {
        const leaguesOfInterest = _.filter(globals.data.leagues, { isDefault: true });
        return _.map(leaguesOfInterest, 'name');
    }
}

// Get the club + international teams of interest for the given user
function getTeamsOfInterestForUser(globals, deviceId) {
    const preferences = _.get(globals.data.userPreferencesCache, deviceId);
    if (!preferences) {
        return [];
    }
    else {
        const clubTeams = _.get(preferences, 'clubTeams', []);
        const internationalTeams = _.get(preferences, 'internationalTeams', []);
        return clubTeams.concat(internationalTeams);
    }
}


// Sets all matches for the given date, and populate the global "matches" object
// Repeats the process at an interval that depends on the date,
// e.g. every few seconds for matches in progress, every 5 minutes for today's matches, every hour for yesterday's matches
async function setMatchesForDate(globals, date, useSimulator) {

    const matchesApiUrl = useSimulator ? globals.config.urls.matchesApiSimulator : globals.config.urls.matchesApi;

    // Get the date in the format required by the API, YYYYMMDD
    const matchesApiDate = moment(date, 'YYYY-MM-DD').format('YYYYMMDD');
    const url = `${matchesApiUrl.replace('{YYYYMMDD}', matchesApiDate)}`;

    const parseStartTime = moment().toISOString();

    try {
        // Load the matches data
        const response = await axios.get(url);

        // Check the response status code and parse the matches if the response looks valid 
        if (response.status >= 400) {
            console.error(`Invalid HTTP response code from ${url}:`, response.status);
        }
        else {
            const leagues = _.get(response, 'data.leagues', []);
            if (leagues.length > 0) {
                await parseLeagues(globals, leagues, date);
            }
            else {
                console.warn(`No leagues/matches found for ${date} at ${url}`);
            }
        }

    } catch (error) {
        const responseStatus = _.get(error, 'response.status');
        if (responseStatus === 404) {
            _.set(globals.data.parseInfo.details, `${date}.warn`, 'No matches found (404)');
            console.warn(`No matches found for ${date} (404)`);
        }
        else {
            console.error(`Error parsing matches from ${url}: ${error.stack || error}`, _.get(error, 'response.status'));
            _.set(globals.data.parseInfo.details, `${date}.error`, error);
        }
    } finally {
        const parseEndTime = moment().toISOString();
        _.set(globals.data.parseInfo.details, `${date}.parseTime.end`, parseEndTime);
        _.set(globals.data.parseInfo.details, `${date}.parseTime.durationMilliseconds`, moment(parseEndTime).diff(moment(parseStartTime), 'milliseconds'));
    }

    // Repeat the process at an interval that depends on the date
    setParseInterval(globals, date, useSimulator);
}

// Sets the interval for parsing matches for the given date
// If today, repeat every 10 seconds, if yesterday, repeat every 30 minutes, otherwise repeat every hour
function setParseInterval(globals, date, useSimulator) {

    const today = moment().format('YYYY-MM-DD');
    const yesterday = moment().subtract(1, 'days').format('YYYY-MM-DD');

    // TODO: Move to config
    let interval = 0;
    if (date === today)
        interval = 5 * 1000;
    else if (date === yesterday)
        interval = 30 * 60 * 1000;
    else
        interval = 60 * 60 * 1000;

    if (timeouts[date])
        clearTimeout(timeouts[date]);
    timeouts[date] = setTimeout(() => {
        setMatchesForDate(globals, date, useSimulator);
    }, interval);

}


// Parses the given matches from the API response to push them into the global matches array
// For matches taking place today, we use proxy objects so that we can track updates
async function parseLeagues(globals, leagues, date) {

    for (const league of leagues) {
        // Only include leagues whose primaryId matches the ID of a league in globals.data.leagues
        for (const leagueToInclude of globals.data.leagues) {

            const isInternationalCompetition = leagueToInclude.isInternationalCompetition;

            if (league.primaryId === leagueToInclude.id) {
                if (league.matches && league.matches.length > 0) {

                    // Get the match report URLs in blocks of matches at a time
                    let matchReportUrls = [];
                    const max_parallel_requests = globals.config.parsing.max_parallel_requests;
                    for (let i = 0; i < league.matches.length; i += max_parallel_requests) {
                        const matches = league.matches.slice(i, i + max_parallel_requests);
                        let promises = [];
                        for (const match of matches)
                            promises.push(getMatchReportUrl(globals, match.id));
                        matchReportUrls = matchReportUrls.concat(await Promise.all(promises));
                    }

                    let matchIndex = 0;
                    for (const match of league.matches) {

                        const isCancelled = _.get(match, 'status.cancelled', false);

                        if (!isCancelled) {
                            // Get the match info
                            let matchInfo = getMatchInfo(globals, league.name, league.primaryId, isInternationalCompetition, match, date);

                            // Set the match report URL
                            matchInfo.url = matchReportUrls[matchIndex];

                            // Add the match ID to the list of matches in the DB,
                            // and set a watcher to set the interestedUsers array to determine
                            // which users sees / gets notifications for this match
                            const existingMatch = globals.data.matches.find(match => match.id === matchInfo.id);
                            if (!existingMatch && moment(match.status.utcTime).isSame(moment(), 'day')) {
                                console.log('Adding match to DB:', matchInfo.id);
                                db.set('matches_today', matchInfo.id.toString(), { added: moment().toISOString() });
                                if (!matchWatcher)
                                    initMatchWater(globals);
                            }

                            // Add the match to the global matches array
                            pushMatchToGlobalMatches(globals, matchInfo);
                        }

                        matchIndex++;
                    }
                }
            }
        }
    }

}

// Returns the match report URL for the given match ID
async function getMatchReportUrl(globals, matchId) {
    const url = `${globals.config.urls.matchDetailsApi.replace('{MATCHID}', matchId)}`
    let matchReportUrl = undefined;
    try {
        const response = await axios.get(url);

        if (response && response.data) {
            const matchDetails = response.data;
            // Get a post match review if possible, pre-review if not
            matchReportUrl = _.get(matchDetails, 'content.matchFacts.postReview[0].shareUrl');
            if (!matchReportUrl) {
                matchReportUrl = _.get(matchDetails, 'content.matchFacts.preReview[0].shareUrl');
            }
        }
    }
    catch (error) {
        console.error(`Error getting match report URL for match ${matchId}:`, _.get(error, 'code', error));
    }
    return matchReportUrl;
}

// Returns a version of the given string that can be safely used as a Firestore document ID,
// i.e. no forward slashes
function toFireStoreSafe(str) {
    return str.replace(/\//g, '__SLASH__');
}

// Returns the string converted from "Firestore safe" version to its original form
function fromFireStoreSafe(str) {
    return str.replace(/__SLASH__/g, '/');

}

// Create a watcher for any new matches to set the interestedUsers array to determine
// which users sees / gets notifications for this match
function initMatchWater(globals) {
    const query = db.db.collection('matches_today');

    matchWatcher = query.onSnapshot(querySnapshot => {
        querySnapshot.docChanges().forEach(change => {
            if (change.type === 'added') {
                const matchId = fromFireStoreSafe(change.doc.id);
                setInterestedUsersForMatch(globals, matchId);
            }
        });
    }, err => {
        console.error(`Encountered error whilst setting match watcher: ${err}`);
    });
}

// Pushes the given match info to the global matches array
// If the match is already in the array, update the match with the new info
// Otherwise, push it as a new entry
function pushMatchToGlobalMatches(globals, matchInfo) {
    // console.log('Pushing match to global matches:', matchInfo.id);
    const existingMatch = globals.data.matches.find(match => match.id === matchInfo.id);
    const isMatchToday = moment(matchInfo.date).isSame(moment().format('YYYY-MM-DD'));

    // Check if the match is already in the array, and update as necessary
    if (existingMatch) {
        // If the match is today's date, check if it's a proxy object
        if (isMatchToday) {
            // If it is, update the existing match with the new info
            if (existingMatch.isProxy) {
                Object.assign(existingMatch, matchInfo);
            }
            // Otherwise, delete the existing match and create a new proxy object
            else {
                console.log(' ++ Updating existing match with proxy as match is today:', matchInfo.id);
                delete existingMatch;
                globals.data.matches.push(createMatchProxy(globals, matchInfo));
            }
        }
        // Otherwise, simply update the existing match with the new info
        else {
            Object.assign(existingMatch, matchInfo);
        }
    }

    // If the match is not already in the array, push it as a new entry
    else {
        // If the match date is today, create a proxy object for the match
        if (isMatchToday) {
            console.log(' ++ Adding new match proxy as match is today:', matchInfo.id);
            globals.data.matches.push(createMatchProxy(globals, matchInfo));
        }
        // Otherwise, just push the match as a new entry
        else {
            globals.data.matches.push(matchInfo);
        }
    }
}


// Create a match proxy object for the given match info
// This is so that any updates (e.g. score changes) can be tracked for sending out notifications
function createMatchProxy(globals, matchInfo) {
    matchInfo.isProxy = true;
    return Introspected(
        matchInfo,
        (match, path) => {
            if (path && path.length > 0) {
                if (path.includes('homeTeam__score') || path.includes('awayTeam__score') || path.includes('timeLabel') || path.includes('time') || path.includes('started') || path.includes('finished')) {
                    notifications.processMatchUpdate(globals, utils.getJsonExpanded(match), path);
                }
            }
        }
    );
}


// Returns the match in numeric minutes
function getMatchTime(match) {
    const matchTime = _.get(match, 'status.liveTime.long');
    if (matchTime) {
        try {
            return parseInt(matchTime.split(':')[0]);
        }
        catch (error) {
            console.error('Error getting match time:', error);
        }
    }
    return 0;
}

// Gets the match time label, e.g. "12'", "FT", "HT", "AET"
function getMatchTimeLabel(match) {

    const statusReason = _.get(match, 'status.reason.short');

    if (statusReason === 'HT')
        return 'HT';

    // If the match is finished, return "FT" by default, "AET" if it's after extra time or penalties
    const isMatchFinished = _.get(match, 'status.finished', false);
    if (isMatchFinished) {
        if (statusReason !== 'AET' && statusReason !== 'Pen')
            return 'FT';
        else
            return 'AET';
    }

    // Otherwise, return the live time (e.g. "13'") or short reason text (e.g. "Pen")
    else {
        const matchTimeLabel = _.get(match, 'status.liveTime.short');
        if (matchTimeLabel && matchTimeLabel.length > 0)
            return matchTimeLabel;
        else
            return _.get(match, 'status.reason.short', '');
    }
}

// Returns the given match by ID
function getMatchById(globals, matchId) {
    return globals.data.matches.find(match => match.id === matchId);
}


// Returns true if the given team is playing in the given match
function isTeamPlaying(matchInfo, teamName) {
    if (
        matchInfo.homeTeam__names__fullName == teamName ||
        matchInfo.homeTeam__names__displayName == teamName ||
        matchInfo.awayTeam__names__fullName == teamName ||
        matchInfo.awayTeam__names__displayName == teamName
    )
        return true;
    else
        return false;
}

// Gets a match info object
// Note that because the Introspected library only picks up on changes to top-level attributes,
// we need to ensure that the matchInfo object is as flat as possible, i.e. no nested objects
// This is so that we can track changes to the match object, e.g. score/time updates, for notifications,
// which is achieved by creating a proxy object for the match
// Note that we process the match object when returning it for API calls into a properly nested
// object structure suitable for ingestion by the app
function getMatchInfo(globals, competitionSubHeading, competitionId, isInternationalCompetition, match, date) {

    let matchInfo = {};

    const homeTeamNames = getTeamNames(match, 'home');
    const awayTeamNames = getTeamNames(match, 'away');

    const competitionName = _.find(globals.data.leagues, { id: competitionId }).name;

    _.set(matchInfo, 'competition__id', competitionId);
    _.set(matchInfo, 'competition__name', competitionName);
    _.set(matchInfo, 'competition__subHeading', getCompetitionSubHeading(competitionSubHeading, competitionName, match));
    _.set(matchInfo, 'competition__weight', _.find(globals.data.leagues, { id: competitionId }).weight);

    // Home team name
    setTeamNames(matchInfo, 'homeTeam', homeTeamNames);

    // Home team score
    const homeTeamScore = _.get(match, 'home.score');
    _.set(matchInfo, 'homeTeam__score', homeTeamScore);

    // Away team name
    setTeamNames(matchInfo, 'awayTeam', awayTeamNames);

    // Away team score
    const awayTeamScore = _.get(match, 'away.score');
    _.set(matchInfo, 'awayTeam__score', awayTeamScore);

    // Status messages - note we covert the array to a string here to avoid issues with Introspected,
    // which flags up false positives when checking for changes to the match object
    _.set(matchInfo, 'statusMessages', getMatchStatusMessages(match, homeTeamNames.displayName, awayTeamNames.displayName).toString());

    // Aggregate score
    const aggregateScore = _.get(match, 'status.aggregatedStr');
    _.set(matchInfo, 'aggregateScore', aggregateScore);

    // Home team penalty score
    const homePenaltyScore = _.get(match, 'home.penScore', -1);
    _.set(matchInfo, 'homePenaltyScore', homePenaltyScore);

    // Away team penalty score
    const awayPenaltyScore = _.get(match, 'away.penScore', -1);
    _.set(matchInfo, 'awayPenaltyScore', awayPenaltyScore);

    // Match date
    _.set(matchInfo, 'date', date);

    // Kick off date/time info
    const kickOffDateUtc = _.get(match, 'status.utcTime');
    _.set(matchInfo, 'kickOffTime', moment(kickOffDateUtc).format('HH:mm'));
    _.set(matchInfo, 'dateTimeUtc', kickOffDateUtc);
    _.set(matchInfo, 'friendlyDateTime', moment(kickOffDateUtc).calendar({
        sameDay: '[Today]',
        nextDay: '[Tomorrow]',
        lastDay: '[Yesterday]',
        sameElse: 'ddd, DD/MM',
        nextWeek: 'ddd, DD/MM'
    }));

    // Match time (i.e. minutes played of a match in progress) and label
    matchInfo.time = getMatchTime(match);
    matchInfo.timeLabel = getMatchTimeLabel(match);
    matchInfo.started = _.get(match, 'status.started');
    matchInfo.cancelled = _.get(match, 'status.cancelled');
    matchInfo.finished = _.get(match, 'status.finished');

    // Set team ratings
    setTeamRatings(globals, matchInfo, homeTeamNames, awayTeamNames);

    // Match ID (unique ID for the match that React can use)
    // matchInfo.id = `${date}-${matchInfo.homeTeam__names__displayName}-${matchInfo.awayTeam__names__displayName}-${matchInfo.competition__name}-${match.id}`;
    matchInfo.id = match.id;

    // If the match isn't yet finished, then get the TV info
    if (!matchInfo.finished)
        setTvInfo(matchInfo, globals, date, homeTeamNames, awayTeamNames);

    addTeamNamesToGlobals(globals, homeTeamNames, isInternationalCompetition);
    addTeamNamesToGlobals(globals, awayTeamNames, isInternationalCompetition);

    // Get the current interested users from the existing match
    const existingMatch = getMatchById(globals, matchInfo.id);
    if (existingMatch && existingMatch.interestedUsers)
        matchInfo.interestedUsers = existingMatch.interestedUsers;
    else
        matchInfo.interestedUsers = [];

    return matchInfo;

}

// Add the team names to globals.data.teams if they don't already exist
function addTeamNamesToGlobals(globals, teamNames, isInternationalCompetition) {

    // If the team name includes a forward slash (e.g. for "Slovakia/England vs Switzerland)
    // or "Winner" (e..g for "Winner QF1 vs Winner QF2"),
    // or "Loser" (e.g for "Loser SF1 vs Loser SF2"),
    // or is too short, don't do anything
    if (teamNames.fullName.includes('/') || teamNames.fullName.includes('Winner') || teamNames.fullName.includes('Loser') || teamNames.fullName.length < 3)
        return;

    // Determine the category of the team (club or international)
    const category = isInternationalCompetition ? 'international' : 'club';

    if (!globals.data.teams[category].includes(teamNames.displayName))
        globals.data.teams[category].push(teamNames.displayName);

}

// Returns true if the competition is an international competition,
// i.e. its name includes one of the entries under globals.config.competitions.international
function isInternationalCompetition(globals, competitionName) {
    for (const internationalCompetition of globals.config.competitions.international) {
        if (competitionName.includes(internationalCompetition))
            return true;
    }
    return false;
}


function getCompetitionSubHeading(competitionSubHeading, competitionName, match) {
    // Remove the competition name to avoid repetition
    let subHeading = competitionSubHeading.replace(competitionName, '').trim();

    // If it's a tournament stage (e.g. "1/8"), add that info
    if (match.tournamentStage) {
        let tournamentStageLabel = match.tournamentStage;

        if (tournamentStageLabel === '1/16')
            tournamentStageLabel = 'Round of 32';
        else if (tournamentStageLabel === '1/8')
            tournamentStageLabel = 'Round of 16';
        else if (tournamentStageLabel === '1/4')
            tournamentStageLabel = 'Quarter-finals';
        else if (tournamentStageLabel === '1/2')
            tournamentStageLabel = 'Semi-finals';

        if (!isNaN(tournamentStageLabel.trim()))
            tournamentStageLabel = `Round ${tournamentStageLabel}`;

        // Capitalise the first letter of the stage label (e.g. change "final" to "Final")
        tournamentStageLabel = tournamentStageLabel.charAt(0).toUpperCase() + tournamentStageLabel.slice(1);

        if (subHeading.length > 0) {
            subHeading += `: ${tournamentStageLabel}`;
        }
        else {
            subHeading = tournamentStageLabel;
        }
    }

    // Get rid of "Final Stage: " if it's there
    subHeading = subHeading.replace('Final Stage: ', '');

    return subHeading;

}


// Set the team names for the given match info object
function setTeamNames(matchInfo, teamLabel, teamNames) {
    _.set(matchInfo, `${teamLabel}__names__displayName`, teamNames.displayName);
    _.set(matchInfo, `${teamLabel}__names__fullName`, teamNames.fullName);
}

// Sets the team ratings, automatically retrying in the event of no data found
// which can happen if the data hasn't been loaded yet
function setTeamRatings(globals, matchInfo, homeTeamNames, awayTeamNames) {
    matchInfo.homeTeam__rating = getTeamRating(globals, homeTeamNames);
    matchInfo.awayTeam__rating = getTeamRating(globals, awayTeamNames);
}

// Gets the weight of the competition
function getCompetitionWeight(globals, leagueId) {
    return _.get(globals, `config.leagues.weights.${leagueId}`, 0);
}

// Sets the TV channel info for the match
function setTvInfo(matchInfo, globals, date, homeTeamNames, awayTeamNames) {

    const channelInfo = getMatchTvChannelInfo(globals, date, matchInfo.kickOffTime, homeTeamNames, awayTeamNames);

    if (channelInfo && channelInfo.shortName && channelInfo.shortName.length > 0) {
        _.set(matchInfo, 'tvInfo__channelInfo__shortName', channelInfo.shortName);
        _.set(matchInfo, 'tvInfo__channelInfo__fullName', channelInfo.fullName);
    }

}

// Gets the TV channel info for the match, if one exists
function getMatchTvChannelInfo(globals, date, kickOffTime, homeTeamNames, awayTeamNames) {

    let channelInfo = {};

    if (!date)
        date = moment().format('YYYY-MM-DD');

    for (const matchOnTv of globals.data.matchesOnTv) {

        const fixtureDate = moment(matchOnTv.fixture__date__text, 'dddd Do MMMM YYYY').format('YYYY-MM-DD');
        const fixtureTime = matchOnTv.fixture__time;
        let homeTeamNameFound = false;
        let awayTeamNameFound = false;

        if (date == fixtureDate && kickOffTime == fixtureTime) {
            if (isTeamNameFound(matchOnTv.fixture__teams, homeTeamNames))
                homeTeamNameFound = true;
            if (isTeamNameFound(matchOnTv.fixture__teams, awayTeamNames))
                awayTeamNameFound = true;
            // If either team name is found, set the channel info
            // We use fuzzy matching here to account for cases where a tournament is taking place so only one team is known
            // e.g. Portugal / Slovenia vs France
            if (homeTeamNameFound || awayTeamNameFound) {
                channelInfo.shortName = matchOnTv.fixture__channel;
                channelInfo.fullName = matchOnTv.fixture__channel__fullname;
                break;
            }
        }
    }

    return channelInfo;

}

// Returns true if the team name is found in the fixture teams
// Note that we also check if the team name includes any spaces, and if so split the name and check each part
// This is to compensate for scenarios where the BBC website has a name such as "Bayer 04 Leverkusen",
// whilst the Live Football on TV website has the name as "Bayer Leverkusen
function isTeamNameFound(fixtureTeams, teamNames) {
    for (const [key, teamName] of Object.entries(teamNames)) {
        if (fixtureTeams.includes(teamName))
            return true;
        // Otherwise, check if the  team name includes any spaces, and if so split the name and check each part
        else if (teamName.includes(' ')) {
            const teamNameParts = teamName.split(' ');
            for (const teamNamePart of teamNameParts) {
                if (fixtureTeams.includes(teamNamePart))
                    return true;
            }
        }
    }
}

// Gets dispkat and full team names for the given match, either for the home or away team based on the filterText
function getTeamNames(match, filterText) {

    let teamNames = {
        displayName: null,
        fullName: null
    };

    // Get the team data
    const teamNameInfo = _.get(match, filterText);

    try {
        teamNames = {
            displayName: _.get(teamNameInfo, 'name'),
            fullName: _.get(teamNameInfo, 'longName')
        }
    } catch (error) {
        console.error('Error getting team names:', error);
    }

    return teamNames;

}

// Returns a line of status text for the given match
// e.g. "FT", "HT", "90 mins", "Poland win 5-4 on penalties"
function getMatchStatusMessages(match, homeTeamName, awayTeamName) {

    let statusMessages = [];

    // Get the short match status text, e.g. "FT", "HT", "AET"
    // Note that we handle penalties separately below
    const matchStatus = _.get(match, 'status.reason.short');
    if (matchStatus && matchStatus !== 'Pen') {
        statusMessages.push(matchStatus);
    }

    const liveTimeShort = _.get(match, 'status.liveTime.short');

    // Penalties and extra time
    const homePenaltyScore = _.get(match, 'home.penScore', -1);
    const awayPenaltyScore = _.get(match, 'away.penScore', -1);

    if (liveTimeShort === 'ET') {
        statusMessages.push('Waiting for extra time to start');
    }
    else if (liveTimeShort === 'PET') {
        statusMessages.push('Half time in extra time');
    }
    // If the match is in progress, and extra time is being played, add a message to that effect
    else if (!match.status.finished && liveTimeShort !== 'Pen' && (_.get(match, 'status.halfs.firstExtraHalfStarted') || _.get(match, 'status.halfs.secondExtraHalfStarted'))) {
        statusMessages.push('Extra time being played');
    }
    // Otherwise, if penalties are in progress, add a message to that effect
    else if (!match.status.finished && liveTimeShort === 'Pen') {
        if (homePenaltyScore > 0 || awayPenaltyScore > 0) {
            statusMessages.push(`Penalties in progress (${homePenaltyScore} - ${awayPenaltyScore})`);
        }
        else {
            statusMessages.push('Waiting for penalties to start');
        }

    }

    // Aggregate score status (e.g. "Aggregate score: 4-2")
    const aggregateScore = _.get(match, 'status.aggregatedStr');
    if (aggregateScore && aggregateScore.length > 0) {
        statusMessages.push(utils.getAggregateScoreMessage(homeTeamName, awayTeamName, aggregateScore, homePenaltyScore, awayPenaltyScore));
    }

    // Penalties result
    if (match.status.finished && homePenaltyScore >= 0 && awayPenaltyScore >= 0) {
        statusMessages.push(getPenaltiesResultStatusMessage(homeTeamName, awayTeamName, homePenaltyScore, awayPenaltyScore));
    }

    // Convert the de-duped array of messages into a single string
    return _.uniq(statusMessages);

}

function getPenaltiesResultStatusMessage(homeTeamName, awayTeamName, homePenaltyScore, awayPenaltyScore) {
    if (homePenaltyScore > awayPenaltyScore) {
        return `${homeTeamName} win ${homePenaltyScore} - ${awayPenaltyScore} on penalties`;
    }
    else if (homePenaltyScore < awayPenaltyScore) {
        return `${awayTeamName} win ${awayPenaltyScore} - ${homePenaltyScore} on penalties`;
    }
    else {
        return `Penalty shoot-out finished ${homePenaltyScore} - ${awayPenaltyScore}`;
    }
}

// Gets the team rating for the given team names object
// Checks the club team ratings first, then the national team ratings
function getTeamRating(globals, teamNames) {

    // If the team name includes a forward slash, or is "Loser" or "Winner", return 0 
    if (teamNames.displayName.includes('/') || teamNames.displayName.includes('Loser') || teamNames.displayName.includes('Winner'))
        return 0;

    const clubRatings = _.get(globals, 'data.ratings.club', []);
    const nationalRatings = _.get(globals, 'data.ratings.national', []);

    // Check the club team ratings first
    if (clubRatings.length > 0) {
        for (const rating of clubRatings) {
            if (isLikelyMatch(globals, rating.team, teamNames))
                return rating.rating;
        }
    } else {
        // TODO: Restore/remove?
        console.warn('No club ratings found in globals.data.ratings.club for team', teamNames.displayName);
    }

    // Then check the national team ratings
    if (nationalRatings.length > 0) {
        for (const rating of nationalRatings) {
            if (isLikelyMatch(globals, rating.team, teamNames))
                return rating.rating;
        }
    } else {
        // TODO: Restore/remove?
        // console.warn('No national ratings found in globals.data.ratings.national for team', teamNames.displayName);
    }

    // Return 0 for unrated teams
    return 0;
}

// Returns true if the two team names are a likely match
// This is used to determine if two team names are likely to be the same team
function isLikelyMatch(globals, teamName, teamNames) {

    teamName = teamName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "");

    let names = Object.values(teamNames);
    names = names.concat(getTeamAliases(globals, teamNames));

    for (let nameToMatch of names) {

        nameToMatch = nameToMatch.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "");
        if (nameToMatch === teamName)
            return true;
        else if (nameToMatch.includes(teamName) || teamName.includes(nameToMatch))
            return true;
    }

    return false;

}

// Gets any aliases for the given team names
// The reason we need to check aliases as well is that there are some entries in the club ratings
// where the name doesn't quite match up with the names we get from BBC Sport (e.g. "PSG" vs "Paris Saint Germain")
function getTeamAliases(globals, teamNames) {

    for (const aliasArray of globals.config.teams.aliases) {
        // If any of the teamNames values exists in the alias array, return the alias array
        if (Object.values(teamNames).some(name => aliasArray.includes(name)))
            return aliasArray;
    }

    return [];
}


// Sets the match data for past, present and future matches 
// Make the requests sequentially to avoid sending too many requests simultaneously,
// which results in HTTP 429 responses (most likely the Fly.io proxy rate limiting)
async function setMatchData(globals) {

    console.info('Setting match data using API:', globals.config.urls.matchesApi);

    // Get the dates we need to find matches for from the config
    const matchesByDate = getMatchDatesSortedByDate(globals);

    // Delete any proxies for matches that have already finished
    const matchProxies = globals.data.matches.filter(match => match.isProxy && match.finished);
    for (const matchProxy of matchProxies) {
        console.log('Deleting match proxy as match has finished:', matchProxy.id);
        delete matchProxy;
    }

    // Check for the existence of a USE_MATCH_API_SIMULATOR environment variable
    const useSimulator = process.env.USE_MATCH_API_SIMULATOR === 'true';
    if (useSimulator) {
        console.log('Using match API simulator');
    }

    // Parse the matches for each date in blocks of dates at a time
    const parsingStartTime = moment();
    const max_parallel_requests = globals.config.parsing.max_parallel_requests;
    for (let i = 0; i < matchesByDate.length; i += max_parallel_requests) {
        const dates = matchesByDate.slice(i, i + max_parallel_requests);
        let promises = [];
        for (const date of dates)
            promises.push(setMatchesForDate(globals, date, useSimulator));
        await Promise.all(promises);
    }

    // Set the interested users for all matches (for notifications)
    // setInterestedUsersForMatches(globals);

    // Log a summary of the parsing process
    const timeTakenMilliseconds = moment().diff(parsingStartTime, 'milliseconds');
    const timeTaken = moment.duration(timeTakenMilliseconds, 'milliseconds').humanize();
    console.info(`Setting ${globals.data.matches.length} matches took ${timeTaken} (${timeTakenMilliseconds} milliseconds)`);

    let summary = {
        startTime: parsingStartTime.toISOString(),
        endTime: moment().toISOString(),
        matchesParsed: globals.data.matches.length,
        timeTaken: timeTaken,
        timeTakenMilliseconds: timeTakenMilliseconds,
        timeTakenSeconds: timeTakenMilliseconds / 1000,
        timeTakenMinutes: timeTakenMilliseconds / 60000
    }

    _.set(globals, 'data.parseInfo.summary', summary);
}

// Returns an array of match dates sorted for optimal date parsing,
// i.e. today first, then future dates, then past dates
function getMatchDatesSortedByDate(globals) {

    // Get all the match dates
    const matchDates = getMatchDates(globals);

    // Get all dates in the past, and sort them in descending order
    const pastDates = matchDates.filter(date => moment(date).isBefore(moment(), 'day')).sort((a, b) => {
        if (moment(a).isAfter(moment(b), 'day')) return -1;
        return 0;
    });
    // Now get all dates in the future, and sort them in ascending order
    const futureDates = matchDates.filter(date => moment(date).isAfter(moment(), 'day')).sort((a, b) => {
        if (moment(a).isBefore(moment(b), 'day')) return -1;
        return 0;
    });
    // Combine the past and future dates, and then add today's date to the start
    // to ensure we parse today first
    let matchesByDate = futureDates.concat(pastDates);
    matchesByDate.unshift(moment().format('YYYY-MM-DD'));

    return matchesByDate;
}

// Get the dates for which matches are to be parsed
function getMatchDates(globals) {
    let dates = [];

    // Get the date for today and the previous 14 days
    for (let i = 0; i < (globals.config.parsing.days.past + 1); i++)
        dates.push(moment().subtract(i, 'day').format('YYYY-MM-DD'));

    // Get the dates for the next 90 days in the future
    for (let i = 1; i < (globals.config.parsing.days.future + 1); i++) {
        dates.push(moment().add(i, 'day').format('YYYY-MM-DD'));
    }

    return dates;
}

// Returns all the matches in the matches array
function getAllMatches(globals) {
    return globals.data.matches;
}

// Returns an array of fixtures, i.e. matches that are for today or any future date
async function getFixtures(globals, deviceId, limit) {
    let matches = globals.data.matches;
    let fixtures = [];
    for (const match of matches) {
        if (moment(match.date).isSameOrAfter(moment(), 'day'))
            fixtures.push(match);
    }
    return await getMatchesProcessed(globals, fixtures, deviceId, 'asc', limit);
}

// Returns an array of results, i.e. matches that have finished and have a date either today or in the past
async function getResults(globals, deviceId, limit) {
    let matches = globals.data.matches;
    let results = [];
    for (const match of matches) {
        const isMatchFinished = _.get(match, 'finished', false);
        if (isMatchFinished && moment(match.date, 'YYYY-MM-DD').isSameOrBefore(moment(), 'day'))
            results.push(match);
    }
    return await getMatchesProcessed(globals, results, deviceId, 'desc', limit);
}

// Returns an array of matches on TV, i.e. matches that have any TV info
async function getMatchesOnTv(globals, deviceId) {
    let matches = globals.data.matches;
    let matchesOnTv = [];
    for (const match of matches) {
        if (match.tvInfo__channelInfo__fullName && match.tvInfo__channelInfo__fullName.length > 0)
            matchesOnTv.push(match);
    }
    return await getMatchesProcessed(globals, matchesOnTv, deviceId, 'asc');
}

// Returns an array of "processed" matches, i.e.:
// 1. Filter out any matches not of interest to the user, based on their preferences
// 2. All match objects converted into a sane, nested format suitable for ingestion by the app
// 3. Matches sorted by date (either ascending or descending, depending on dateOrder), team names, competition weight and TV channel
async function getMatchesProcessed(globals, matches, deviceId, dateOrder, limit = 0) {

    let processedMatches = [];

    for (const match of matches) {
        if ((deviceId && match.interestedUsers && match.interestedUsers.includes(deviceId)))
            processedMatches.push(utils.getJsonExpanded(match));
    }
    if (limit > 0)
        processedMatches = processedMatches.slice(0, limit);
    return getMatchesSorted(processedMatches, dateOrder);
}

// Returns true if the match is "of interest" to the user
function isMatchOfInterestToUser(globals, match, competitionsOfInterest, teamsOfInterest) {
    // If the match is of interest based on the competition or team name, return true
    if (competitionsOfInterest && competitionsOfInterest.length > 0 && isMatchOfInterestByCompetition(globals, match, competitionsOfInterest))
        return true;
    else if (teamsOfInterest && teamsOfInterest.length > 0 && isMatchOfInterestByTeam(match, teamsOfInterest))
        return true;
    else
        return false;
}

// Returns true if the match is "of interest" to the user based on the competition name
function isMatchOfInterestByCompetition(globals, match, competitionsOfInterest) {

    for (const competition of competitionsOfInterest) {
        if (competition) {

            // Check for El Clasico
            if (competition === 'El Clasico' && match.competition__name === 'LaLiga' && isTeamPlaying(match, 'Real Madrid') && isTeamPlaying(match, 'Barcelona'))
                return true;

            // Check for top teams
            else if (competition.includes('Top teams')) {
                for (const topTeam of globals.data.topTeams) {
                    if (isCompetitionMatch(competition, match) && (match.homeTeam__names__fullName === topTeam || match.homeTeam__names__displayName === topTeam || match.awayTeam__names__fullName === topTeam || match.awayTeam__names__displayName === topTeam))
                        return true;
                }
            }

            // Otherwise, check for a competition name match
            else {
                if (isCompetitionMatch(competition, match))
                    return true;
            }
        }
    }
    return false;
}

// Returns true if the match is a match in the given competition
function isCompetitionMatch(competition, match) {
    competition = competition.replace(': Top teams', '');
    competition = competition.replace(': All matches', '');
    competition = competition.toLowerCase();

    let competitionFullName = match.competition__name.toLowerCase();
    if (match.competition__subHeading && match.competition__subHeading.length > 0)
        competitionFullName += `: ${match.competition__subHeading.toLowerCase()}`;

    const competitionName = match.competition__name.toLowerCase();

    if (competition == competitionFullName || competition === competitionName)
        return true;
}

// Returns true if the match is "of interest" to the user based on the team name
function isMatchOfInterestByTeam(match, teamsOfInterest) {
    for (const team of teamsOfInterest) {
        if (team && isCompetitionRelevantForTeam(match, team) && (match.homeTeam__names__fullName.toLowerCase() === team.toLowerCase() || match.awayTeam__names__fullName.toLowerCase() === team.toLowerCase()))
            return true;
    }
    return false;
}

// Returns true if the competition is of relevance to the team
// e.g. if the user is interested in "England", assume it's the men's team
// and don't return any matches for competitions involving women's or youth football
// TODO: Add support for wommen's + youth teams (e.g. "England Women", "England Youth", "England School")
function isCompetitionRelevantForTeam(match, team) {

    if (team.toLowerCase().includes('women') && match.competition__name.toLowerCase().includes('women'))
        return true;

    else if (team.toLowerCase().includes('under') && match.competition__name.toLowerCase().includes('under'))
        return true;

    else if (team.toLowerCase().includes('school') && match.competition__name.toLowerCase().includes('school'))
        return true;

    else return !match.competition__name.includes('Women') &&
        !match.competition__name.includes('Under') &&
        !match.competition__name.includes('School')
}

// Returns an array of matches sorted by date, team names, competition weight and TV channel
function getMatchesSorted(matches, dateOrder) {
    return _.orderBy(matches, ['dateTimeUtc', 'kickOffTime', 'competition.weight', 'competition.name', 'competition.subHeading', 'homeTeam.names.displayName', 'tvInfo.channelInfo.fullName'], [dateOrder, dateOrder, 'desc', 'desc', 'asc', 'desc', 'asc']);
}

// Returns an array of competition names (used for the app to select competitions of interest)
function getCompetitions(globals) {

    let competitions = [];

    for (const league of globals.data.leagues) {
        competitions.push(league.name);
        if (globals.config.leagues.offerTopTeams.includes(league.id))
            competitions.push(`${league.name}: Top teams`);
    }

    return _.uniq(competitions).sort();
}

// Returns an array of all team names for the given category (club or international)
function getTeams(globals, category) {
    let teams = globals.data.teams[category].sort();
    // Filter out any teams with a forward slash ("/") or "Winner" in their name, as they are not valid team names
    // but can exist for tournament fixtures (e.g. "England/Slovakia vs Switzerland", "Winner QF1 vs Winner QF2")
    teams = teams.filter(team => !team.includes('/'));
    teams = teams.filter(team => !team.includes('Winner'));
    return teams;
}


module.exports = {
    setMatchData,
    getAllMatches,
    getFixtures,
    getMatchesOnTv,
    getResults,
    getCompetitions,
    getTeams,
    getMatchById,
    setMatchesOfInterestForUser,
    isLikelyMatch
}