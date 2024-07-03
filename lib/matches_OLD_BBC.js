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
    for (let match of globals.data.matches)
        setMatchOfInterestToUser(globals, match, deviceId);
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
    } else {
        if (match.interestedUsers.includes(deviceId)) {
            // console.log('Match is no longer of interest to user:', match.id);
            match.interestedUsers = match.interestedUsers.filter(user => user !== deviceId);
        }
    }
}

// Get the competitions of interest for the given user
function getCompetitionsOfInterestForUser(globals, deviceId) {
    const preferences = _.get(globals.data.userPreferencesCache, deviceId);
    if (!preferences) {
        console.warn('No preferences found for user:', deviceId);
        return [];
    }
    else
        return _.get(preferences, 'competitions', []);
}

// Get the club + international teams of interest for the given user
function getTeamsOfInterestForUser(globals, deviceId) {
        const preferences = _.get(globals.data.userPreferencesCache, deviceId);
        if (!preferences) {
            console.warn('No preferences found for user:', deviceId);
            return [];
        }
        else {
            const clubTeams = _.get(preferences, 'clubTeams', []);
            const internationalTeams = _.get(preferences, 'internationalTeams', []);
            return clubTeams.concat(internationalTeams);
        }
}


// Parse all matches for the given date, and populate the global "matches" object
// Repeats the process at an interval that depends on the date,
// e.g. every few seconds for matches in progress, every 5 minutes for today's matches, every hour for yesterday's matches
async function parseMatchesForDate(globals, date) {

    // console.log('Parsing matches for', date);

    const url = `${globals.config.urls.scoresAndFixtures}/${date}`;

    const parseStartTime = moment().toISOString();
    _.set(globals.data.parseInfo.details, `${date}.parseTime.start`, parseStartTime);
    _.set(globals.data.parseInfo.details, `${date}.url`, url);

    try {
        // Load the matches data
        // console.log('Getting matches from:', url);
        const response = await axios.get(url);
        const html = response.data;

        // Log the response status code
        if (response.status !== 200)
            console.warn(`Non-200 response code from ${url}:`, response.status);
        _.set(globals.data.parseInfo.details, `${date}.statusCode`, response.status);

        parseMatchesFromHtml(globals, html, date);

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
    setParseInterval(globals, date);
}

// Sets the interval for parsing matches for the given date
// If today, repeat every 10 seconds, if yesterday, repeat every 30 minutes, otherwise repeat every hour
function setParseInterval(globals, date) {

    const today = moment().format('YYYY-MM-DD');
    const yesterday = moment().subtract(1, 'days').format('YYYY-MM-DD');

    // TODO: Move to config
    let interval = 0;
    if (date === today)
        interval = 10 * 1000;
    else if (date === yesterday)
        interval = 30 * 60 * 1000;
    else
        interval = 60 * 60 * 1000;

    if (timeouts[date])
        clearTimeout(timeouts[date]);
    timeouts[date] = setTimeout(() => {
        parseMatchesForDate(globals, date);
    }, interval);

}

// Parses the given HTML block to extract the matches, and push them
// to the global matches array (as proxy objects so that we can track updates)
function parseMatchesFromHtml(globals, html, date) {
    const $ = cheerio.load(html);

    let matchCount = 0;

    let previousCompetitionName = '';

    // For each block of matches (separated by competition), find the 
    // competition name and all the associated scores
    // Only match those involving top flight teams
    // Find each header wrapper for each competition (e.g. "UEFA Europa League", "English Premier League"),
    // and then iterate through each match in that competition
    $('div[class*="HeaderWrapper"]').each((index, matchBlock) => {

        // Get the competition name (e.g. "Internationals")
        let competition = {};
        _.set(competition, 'name', $(matchBlock).find('h2[class*="PrimaryHeading"]').first().text());

        // If the competition name is empty, use the previous competition name
        // This is needed as BBC Sport doesn't always repeat the competition name (e.g. for "Group A", "Group B", etc.)
        if (!competition.name || competition.name.length === 0)
            _.set(competition, 'name', previousCompetitionName);
        else
            previousCompetitionName = competition.name;

        // Competition subheading (e.g. "Friendlies")
        const competitionSecondaryHeading = $(matchBlock).find('h3[class*="SecondaryHeading"]').first();
        if (competitionSecondaryHeading)
            _.set(competition, 'subHeading', $(competitionSecondaryHeading).text());

        // Iterate through all the matches
        const matchesHtml = $(matchBlock).find('div[class*="HeadToHeadWrapper"]');
        for (const matchHtml of matchesHtml) {
            let matchInfo = getMatchInfo(globals, competition, matchHtml, $, date);
            _.set(matchInfo, 'parseTime', moment().toISOString());

            // Add the match ID to the list of matches in the DB,
            // and set a watcher to set the interestedUsers array to determine
            // which users sees / gets notifications for this match
            const existingMatch = globals.data.matches.find(match => match.id === matchInfo.id);
            if (!existingMatch) {
                db.set('matches', toFireStoreSafe(matchInfo.id), { added: moment().toISOString() });
                if (!matchWatcher)
                    initMatchWater(globals);
            }

            // Add the match to the global matches array
            pushMatchToGlobalMatches(globals, matchInfo);

            matchCount++;
        }

    });

    // console.info(`Parsed ${matchCount} matches for ${date}`);

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
    console.log('Watching matches collection for changes');
    const query = db.db.collection('matches');

    matchWatcher = query.onSnapshot(querySnapshot => {
        querySnapshot.docChanges().forEach(change => {
            if (change.type === 'added') {
                const matchId = fromFireStoreSafe(change.doc.id);
                setInterestedUsersForMatch(globals, matchId);
            }
        });
    }, err => {
        console.log(`Encountered error: ${err}`);
    });
}

// Pushes the given match info to the global matches array
// If the match is already in the array, update the match with the new info
// Otherwise, push it as a new entry
function pushMatchToGlobalMatches(globals, matchInfo) {

    // Create a match proxy if match date is today or in the future
    let matchProxy = matchInfo;
    if (moment(matchInfo.date).isSameOrAfter(moment().format('YYYY-MM-DD')))
        matchProxy = createMatchProxy(globals, matchInfo);

    const existingMatch = globals.data.matches.find(match => match.id === matchInfo.id);
    if (existingMatch) {
        // Update the existing match with the new info
        Object.assign(existingMatch, matchInfo);
    }
    else {
        // console.log('Adding new match:', matchInfo.id);
        globals.data.matches.push(matchProxy);
    }

}


// Create a match proxy object for the given match info
// This is so that any updates (e.g. score changes) can be tracked for sending out notifications
function createMatchProxy(globals, matchInfo) {
    return Introspected(
        matchInfo,
        (match, path) => {
            if (path && path.length > 0) {
                if (path.includes('homeTeam__score') || path.includes('awayTeam__score') || path.includes('timeLabel') || path.includes('time')) {
                    // console.log('Match updated:', path, match.id, match.homeTeam__names__displayName, match.awayTeam__names__displayName, match.homeTeam__score, match.awayTeam__score, match.time, match.timeLabel);
                    notifications.processMatchUpdate(globals, utils.getJsonExpanded(match), path);
                }
            }
        }
    );
}


// Gets the match time value from the status text, e.g. "13'" -> 13
// Also caters for extra time, e.g. "45' +2" -> "47"
function getMatchTime(match) {
    for (const statusMessage of match.statusMessages) {
        if (statusMessage.includes("' +")) {
            const time = statusMessage.split("'")[0];
            const extraTime = statusMessage.split("+")[1];
            return parseInt(time) + parseInt(extraTime);
        }
        else if (statusMessage.includes("'"))
            return parseInt(statusMessage.split("'")[0]);
        else if (statusMessage === 'HT')
            return 45;
    }
    return 0;
}

// Gets the match time label from the status text, e.g. "45' +2" -> "47"
function getMatchTimeLabel(match) {
    for (const statusMessage of match.statusMessages) {
        if (statusMessage.includes("'") || statusMessage === 'HT' || statusMessage === 'HT ET' || statusMessage === 'FT' || statusMessage === 'AET')
            return statusMessage;
    }
}

// Returns the given match by ID
function getMatchById(globals, matchId) {
    return globals.data.matches.find(match => match.id === matchId);
}


// Returns true if the match is "of interest", i.e.:
//  1. A top flight team is involved
//  2. England men's national team are playing
// function isMatchOfInterest(globals, matchInfo, logDecision = false) {

//     // If the competition name is included in the list of competitions where all matches should be shown, return true
//     for (const competitionName of globals.config.competitions.showAllMatches) {
//         if (matchInfo.competition__name.toLowerCase().includes(competitionName.toLowerCase())) {
//             if (logDecision)
//                 console.log('Match is of interest (show all):', matchInfo.id, matchInfo.competition__name);
//             return true;
//         }
//     }

//     if (logDecision)
//         console.log('Match is NOT of interest (show all):', matchInfo.id, matchInfo.competition__name);

//     // Filter out competitions that aren't of interest (youth teams, etc.)
//     if (matchInfo.competition__name.includes('Women') || matchInfo.competition__name.includes('Under') || matchInfo.competition__name.includes('School')) {
//         if (logDecision)
//             console.log('Match is NOT of interest (youth):', matchInfo.id, matchInfo.competition__name);
//         return false;
//     }

//     // Show European finals
//     if (matchInfo.competition__name.includes('UEFA') && matchInfo.competition__subHeading.includes('Final')) {
//         if (logDecision)
//             console.log('Match is of interest (UEFA final):', matchInfo.id, matchInfo.competition__name);
//         return true;
//     }

//     if (logDecision)
//         console.log('Match is NOT of interest (UEFA final):', matchInfo.id, matchInfo.competition__name);

//     // Show EFL play-offs
//     if (matchInfo.competition__name.includes('English Football League') && matchInfo.competition__subHeading.includes('Play-Offs')) {
//         if (logDecision)
//             console.log('Match is of interest (EFL play-off):', matchInfo.id, matchInfo.competition__name);
//         return true;
//     }

//     if (logDecision)
//         console.log('Match is NOT of interest (EFL play-off):', matchInfo.id, matchInfo.competition__name);

//     // Only show El Classico, otherwise ignore other domestic leagues
//     if (matchInfo.competition__name === 'Spanish La Liga' && isTeamPlaying(matchInfo, 'Real Madrid') && isTeamPlaying(matchInfo, 'Barcelona')) {
//         if (logDecision)
//             console.log('Match is of interest (El Classico):', matchInfo.id, matchInfo.competition__name);
//         return true;
//     }

//     if (logDecision)
//         console.log('Match is NOT of interest (El Classico):', matchInfo.id, matchInfo.competition__name);

//     // Only England internationals
//     if (matchInfo.competition__name === ('Internationals') &&
//         (
//             matchInfo.homeTeam__names__fullName === 'England' ||
//             matchInfo.awayTeam__names__fullName === 'England'
//         )) {
//         if (logDecision)
//             console.log('Match is of interest (England):', matchInfo.id, matchInfo.competition__name);
//         return true;
//     }

//     if (logDecision)
//         console.log('Match is NOT of interest (England international):', matchInfo.id, matchInfo.competition__name);

//     // Otherwise, only include competitions that have a weight in competitions.json
//     if (globals.config.competitions.weights[matchInfo.competition__name]) {
//         for (const topTeam of globals.data.topTeams) {
//             if (matchInfo.homeTeam__names__fullName === topTeam || matchInfo.awayTeam__names__fullName === topTeam) {
//                 if (logDecision)
//                     console.log('Match is of interest (weighted competition + top team):', matchInfo.id, matchInfo.competition__name);
//                 return true;
//             }
//         }

//         if (logDecision)
//             console.log('Match is NOT of interest (weighted competition + top team):', matchInfo.id, matchInfo.competition__name);

//         if (matchInfo.homeTeam__names__fullName === 'England' || matchInfo.awayTeam__names__fullName === 'England') {
//             if (logDecision)
//                 console.log('Match is of interest (weighted competition + England):', matchInfo.id, matchInfo.competition__name);
//             return true;
//         }

//         if (logDecision)
//             console.log('Match is NOT of interest (weighted competition + England):', matchInfo.id, matchInfo.competition__name);
//     }

//     if (logDecision)
//         console.log('Match is NOT of interest:', matchInfo.id, matchInfo.competition__name);
//     return false;

// }

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
function getMatchInfo(globals, competition, match, $, date) {

    let matchInfo = {};

    const homeTeamNames = getTeamNames($, match, 'HomeTeam');
    const awayTeamNames = getTeamNames($, match, 'AwayTeam');

    const homeTeamNameAliases = getTeamAliases(globals, homeTeamNames);
    const awayTeamNameAliases = getTeamAliases(globals, awayTeamNames);

    _.set(matchInfo, 'competition__name', competition.name);
    _.set(matchInfo, 'competition__subHeading', competition.subHeading);
    _.set(matchInfo, 'competition__weight', getCompetitionWeight(globals, competition));

    // Home team name
    setTeamNames(matchInfo, 'homeTeam', homeTeamNames);

    // Home team score
    const homeTeamScore = $(match).find('div[class*="HomeScore"]').first();
    _.set(matchInfo, 'homeTeam__score', $(homeTeamScore).text());

    // Away team name
    setTeamNames(matchInfo, 'awayTeam', awayTeamNames);

    // Away team score
    const awayTeamScore = $(match).find('div[class*="AwayScore"]').first();
    _.set(matchInfo, 'awayTeam__score', $(awayTeamScore).text());

    // Match report URL
    matchInfo.url = getMatchUrl(globals, match, $);

    // Status messages
    matchInfo.statusMessages = getMatchStatusMessages(match, $, matchInfo.tvInfo);

    // Match date
    matchInfo.date = date;

    // Kick off time (e.g. "19:45")
    const kickOffTime = $(match).find('time[class*="StyledTime"]').first();
    if (kickOffTime && $(kickOffTime).text().trim().length > 0 && $(kickOffTime).text().includes(':'))
        matchInfo.kickOffTime = $(kickOffTime).text().trim();

    // Match date and time in UTC, based on the date and kick off time
    if (matchInfo.kickOffTime) {
        matchInfo.dateTimeUtc = moment(`${date} ${matchInfo.kickOffTime}`, 'YYYY-MM-DD HH:mm').toISOString();
        matchInfo.friendlyDateTime = moment(`${date} ${matchInfo.kickOffTime}`).calendar({
            sameDay: '[Today]',
            nextDay: '[Tomorrow]',
            lastDay: '[Yesterday]',
            sameElse: 'ddd, DD/MM',
            nextWeek: 'ddd, DD/MM'
        });
    }

    // Match time (i.e. minutes played of a match in progress) and label
    matchInfo.time = getMatchTime(matchInfo);
    matchInfo.timeLabel = getMatchTimeLabel(matchInfo);

    // Match parsing info
    matchInfo.parseTime = moment().toISOString();

    // Set team ratings
    setTeamRatings(globals, matchInfo, homeTeamNames, awayTeamNames);

    // Match ID (unique ID for the match that React can use)
    matchInfo.id = `${date}-${matchInfo.homeTeam__names__displayName}-${matchInfo.awayTeam__names__displayName}-${matchInfo.competition__name}`;

    // If the match isn't over (timeLabel isn't "FT" or "AET"), then get the TV info
    if (matchInfo.timeLabel !== 'FT' && matchInfo.timeLabel !== 'AET')
        setTvInfo(matchInfo, globals, date, homeTeamNames, awayTeamNames);

    addTeamNamesToGlobals(globals, homeTeamNames, matchInfo.competition__name);
    addTeamNamesToGlobals(globals, awayTeamNames, matchInfo.competition__name);

    // Get the current interested users from the existing match
    const existingMatch = getMatchById(globals, matchInfo.id);
    if (existingMatch && existingMatch.interestedUsers)
        matchInfo.interestedUsers = existingMatch.interestedUsers;
    else
        matchInfo.interestedUsers = [];

    return matchInfo;

}

// Add the team names to globals.data.teams if they don't already exist
function addTeamNamesToGlobals(globals, teamNames, competitionName) {

    // If the team name is either "TBC" or "Team to be confirmed", don't do anything
    if (teamNames.fullName === 'TBC' || teamNames.fullName === 'Team to be confirmed')
        return;

    const category = isInternationalCompetition(globals, competitionName) ? 'international' : 'club';

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
function getCompetitionWeight(globals, competition) {
    return globals.config.competitions.weights[competition.name] || 0;
}

// Sets the TV channel info for the match
function setTvInfo(matchInfo, globals, date, homeTeamNames, awayTeamNames) {

    const channelInfo = getMatchTvChannelInfo(globals, date, homeTeamNames, awayTeamNames);

    if (channelInfo && channelInfo.shortName && channelInfo.shortName.length > 0) {
        _.set(matchInfo, 'tvInfo__channelInfo__shortName', channelInfo.shortName);
        _.set(matchInfo, 'tvInfo__channelInfo__fullName', channelInfo.fullName);
    }

}

// Gets the TV channel info for the match, if one exists
function getMatchTvChannelInfo(globals, date, homeTeamNames, awayTeamNames) {

    let channelInfo = {};

    if (!date)
        date = moment().format('YYYY-MM-DD');

    for (const matchOnTv of globals.data.matchesOnTv) {

        const fixtureDate = moment(matchOnTv.fixture__date__text, 'dddd Do MMMM YYYY').format('YYYY-MM-DD');
        let homeTeamNameFound = false;
        let awayTeamNameFound = false;

        if (date == fixtureDate) {

            // Return the TV channel if both the home and away team names are found in the "fixture__teams" value
            for (const [key, homeTeamName] of Object.entries(homeTeamNames)) {
                if (isTeamNameFound(matchOnTv.fixture__teams, homeTeamNames))
                    homeTeamNameFound = true;
            }

            for (const [key, awayTeamName] of Object.entries(awayTeamNames)) {
                if (isTeamNameFound(matchOnTv.fixture__teams, awayTeamNames))
                    awayTeamNameFound = true;
            }

            if (homeTeamNameFound && awayTeamNameFound) {
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
function getTeamNames($, match, filterText) {

    let teamNames = {
        displayName: null,
        fullName: null
    };

    // Get the team data
    const teamNameInfo = $(match).find(`div[class*="-${filterText}"]`).first();

    try {
        teamNames.fullName = $(teamNameInfo).find(`span[class*="VisuallyHidden"]`).first().text();
        teamNames.displayName = $(teamNameInfo).find(`span[class*="MobileValue"]`).first().text();
    } catch (error) {
        console.error('Error getting team names:', error);
    }

    // If we didn't manage to get a display name, use the full name
    if (!teamNames.displayName)
        teamNames.displayName = teamNames.fullName;

    return teamNames;

}

// Returns a line of status text for the given match
// e.g. "FT", "HT", "90 mins", "Poland win 5-4 on penalties"
function getMatchStatusMessages(match, $) {

    let statusMessages = [];

    const matchStatusHtml = $(match).find('div[class*="MatchProgressContainer"]').first();

    // Match time status (e.g. "FT", "HT", "AET")
    const matchStatusTime = $(matchStatusHtml).find('div[class*="StyledPeriod"]').first();
    if (matchStatusTime && $(matchStatusTime).text().trim().length > 0)
        statusMessages.push($(matchStatusTime).text().trim());

    // Aggregate score status (e.g. "Agg 4-2")
    addAggregateScoreInfo(matchStatusHtml, $, statusMessages);

    // Penalty win status (e.g. "Poland win 5-4 on penalties")
    addPenaltyWinInfo(match, $, statusMessages);

    // Remove any empty status messages in case we've managed to accidentally capture any empty strings
    statusMessages = statusMessages.filter(message => message.length > 0);

    // Convert the de-duped array of messages into a single string
    return _.uniq(statusMessages);

}

// Adds information about the aggregate score to the status messages
function addAggregateScoreInfo(matchStatusHtml, $, statusMessages) {
    const aggregateScoreInfoLabel = $(matchStatusHtml).find('div[class*="AggregateScore"]').first();
    if (aggregateScoreInfoLabel) {
        const aggregateScoreInfoText = $(aggregateScoreInfoLabel).text().trim().replace('(', '').replace(')', '');
        statusMessages.push(aggregateScoreInfoText);
    }
}

// Adds information about the penalty winner to the status messages
// e.g.: "Olympique Marseille win 4 - 2 on penalties"
function addPenaltyWinInfo(match, $, statusMessages) {
    const penaltyWinInfoContainer = $(match).find('div[class*="PenaltyScoresContainer"]').first();
    if (penaltyWinInfoContainer) {
        const penaltyWinInfoLabel = $(penaltyWinInfoContainer).find('span[class*="VisuallyHidden"]').first();
        if (penaltyWinInfoLabel)
            statusMessages.push(penaltyWinInfoLabel.text().trim());
    }
}

// Gets the link to the BBC Sport match report URL
function getMatchUrl(globals, match, $) {

    // Match status information
    const matchLink = $(match).find('a[class*="OnwardJourneyLink"]').first().attr('href');
    if (matchLink)
        return `${globals.config.urls.matchReportLinkPrefix}${matchLink}`;
    else
        return `${globals.config.urls.matchReportNoLink}`;

}

// Gets the team rating for the given team names object
// Checks the club team ratings first, then the national team ratings
function getTeamRating(globals, teamNames) {

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

    // Get the dates we need to find matches for from the config
    const matchesByDate = getMatchDatesSortedByDate(globals);

    // Parse the matches for each date in blocks of dates at a time
    const parsingStartTime = moment();
    const max_parallel_requests = globals.config.parsing.max_parallel_requests;
    for (let i = 0; i < matchesByDate.length; i += max_parallel_requests) {
        const dates = matchesByDate.slice(i, i + max_parallel_requests);
        let promises = [];
        for (const date of dates)
            promises.push(parseMatchesForDate(globals, date));
        await Promise.all(promises);
    }

    // Set the interested users for all matches (for notifications)
    // setInterestedUsersForMatches(globals);

    // Log a summary of the parsing process
    const timeTakenMilliseconds = moment().diff(parsingStartTime, 'milliseconds');
    const timeTaken = moment.duration(timeTakenMilliseconds, 'milliseconds').humanize();
    console.info(`Parsing ${globals.data.matches.length} matches took ${timeTaken} (${timeTakenMilliseconds} milliseconds)`);

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

// Returns an array of results, i.e. matches where the time label is "FT" or "AET" or that have a date in the past
async function getResults(globals, deviceId, limit) {
    let matches = globals.data.matches;
    let results = [];
    for (const match of matches) {
        if (moment(match.date, 'YYYY-MM-DD').isBefore(moment(), 'day') || (match.timeLabel && (match.timeLabel === 'FT' || match.timeLabel === 'AET')))
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

// Returns an array of predictor matches
async function getPredictorMatches(globals, deviceId) {
    let matches = await getFixtures(globals, deviceId);
    let predictorMatches = [];

    // First get a list of matches that haven't already kicked off
    for (const match of matches) {
        if (moment(match.date).isSameOrAfter(moment(), 'day') && (!match.dateTimeUtc || moment(match.dateTimeUtc).isAfter(moment()) && match.timeLabel !== 'FT' && match.timeLabel !== 'AET'))
            predictorMatches.push(utils.getJsonExpanded(match));
    }

    // Then, overwrite the "real" matches with any existing predictor matches
    const existingPredictorMatches = _.get(globals, `data.predictorMatches.${deviceId}`, []);
    for (const existingPredictorMatch of existingPredictorMatches) {
        const matchIndex = predictorMatches.findIndex(match => match.id === existingPredictorMatch.id);
        if (matchIndex > -1) {
            predictorMatches[matchIndex] = existingPredictorMatch;
        }
    }

    return getMatchesSorted(predictorMatches, 'asc');
}

// Returns an array of "processed" matches, i.e.:
// 1. Filter out any matches not of interest to the user, based on their preferences
// 2. All match objects converted into a sane, nested format suitable for ingestion by the app
// 3. Matches sorted by date (either ascending or descending, depending on dateOrder), team names, competition weight and TV channel
async function getMatchesProcessed(globals, matches, deviceId, dateOrder, limit = 0) {

    let processedMatches = [];

    for (const match of matches) {
        if (match.interestedUsers && match.interestedUsers.includes(deviceId))
            processedMatches.push(utils.getJsonExpanded(match));
    }
    if (limit > 0)
        processedMatches = processedMatches.slice(0, limit);
    return getMatchesSorted(processedMatches, dateOrder);
}

// TODO: Remove
// // Returns the competitions of interest for the user
// async function getCompetitionsOfInterestForUser(deviceId) {
//     return await users.getPreference(deviceId, 'competitions');
// }

// // Returns the teams of interest for the user
// async function getTeamsOfInterestForUser(deviceId) {
//     const clubTeams = await users.getPreference(deviceId, 'clubTeams') || [];
//     const internationalTeams = await users.getPreference(deviceId, 'internationalTeams') || [];
//     return clubTeams.concat(internationalTeams);
// }

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
            if (competition === 'El Clasico' && match.competition__name === 'Spanish La Liga' && isTeamPlaying(match, 'Real Madrid') && isTeamPlaying(match, 'Barcelona'))
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

    const competitionFullName = `${match.competition__name.toLowerCase()}: ${match.competition__subHeading.toLowerCase()}`;
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
    return _.orderBy(matches, ['date', 'kickOffTime', 'competition.weight', 'competition.name', 'competition.subHeading', 'homeTeam.names.displayName', 'tvInfo.channelInfo.fullName'], [dateOrder, dateOrder, 'desc', 'desc', 'asc', 'desc', 'asc']);
}

// Returns an array of competition names, collating all unique competition name/subheading combinations
function getCompetitions(globals) {
    const matches = globals.data.matches;
    let competitionNames = [];  // Full name, e.g. "Internationals: Friendlies 1"
    for (const match of matches) {
        let competitionName = match.competition__name;
        // competitionNames.push(`${competitionName}: All matches`);
        if (match.competition__subHeading && match.competition__subHeading.length > 0) {
            competitionName += `: ${match.competition__subHeading}`;
        }
        if (!competitionNames.includes(competitionName))
            competitionNames.push(competitionName);
    }

    // Find any entry in the competitionNames array that appears more than once, e.g.:
    //   "Internationals: Friendlies 1",
    //   "Internationals: Friendlies 2",
    //   "Internationals: Friendlies 3",
    // and then for each entry, add the "All matches" option, e.g.:
    //   "Internationals: All matches",
    let allMatchesCompetitions = [];
    for (const competitionName of competitionNames) {
        const competitionTitle = competitionName.split(':')[0];
        const competitionCount = competitionNames.filter(name => name.includes(competitionTitle)).length;
        if (competitionCount > 1)
            allMatchesCompetitions.push(`${competitionTitle}: All matches`);
    }
    competitionNames = competitionNames.concat(allMatchesCompetitions);

    // For any competition for which the user should be offered a chance to see top teams only,
    // add an option for the user to see only the top teams, "English FA Cup: Top teams"
    // Note that we only bother checking competitions that have an "All matches" option, e.g. "English FA Cup: All matches"
    let topTeamsCompetitions = [];
    for (const competitionName of competitionNames.filter(name => name.includes('All matches'))) {
        const competitionTitle = competitionName.split(':')[0];
        if (globals.config.competitions.offerTopTeams.includes(competitionTitle))
            topTeamsCompetitions.push(`${competitionTitle}: Top teams`);
    }
    competitionNames = competitionNames.concat(topTeamsCompetitions);

    // De-dupe the array and sort it before returning
    return _.uniq(competitionNames).sort();
}

// Returns an array of all team names for the given category (club or international)
function getTeams(globals, category) {
    return globals.data.teams[category].sort();
}


module.exports = {
    setMatchData,
    getAllMatches,
    getFixtures,
    getMatchesOnTv,
    getResults,
    getPredictorMatches,
    getCompetitions,
    getTeams,
    getMatchById,
    setMatchesOfInterestForUser,
    isLikelyMatch
}