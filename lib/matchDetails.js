const axios = require('axios');
const _ = require('lodash');

async function getMatchDetails(globals, matchId) {
    const url = `${globals.config.urls.matchDetailsApi.replace('{MATCHID}', matchId)}`;
    try {
        const response = await axios.get(url);
        return getMatchDetailsProcessed(response.data);
    } catch (error) {
        console.error(error);
        return null;
    }
}

function getMatchDetailsProcessed(matchDetails) {
    if (matchDetails) {
        const matchId = _.get(matchDetails, 'general.matchId', null);
        return {
            matchId: matchId,
            events: getEvents(matchDetails),
            penalties: getPenalties(matchDetails),
            infoUrl: `https://www.fotmob.com/match/${matchId}`,
            matchReportUrl: _.get(matchDetails, 'content.matchFacts.postReview[0].shareUrl', null),
            highlightsUrl: _.get(matchDetails, 'content.matchFacts.highlights.url', null),
            stadiumName: _.get(matchDetails, 'content.matchFacts.infoBox.Stadium.name', null),
            attendance: _.get(matchDetails, 'content.matchFacts.infoBox.Attendance', null),
        }
    }
}

function getEvents(matchDetails) {
    const events = _.map(_.get(matchDetails, 'content.matchFacts.events.events', []), (event) => {
        return {
            time: event.time,
            type: event.type,
            isHome: event.isHome,
            ownGoal: event.ownGoal,
            goalDescription: event.goalDescription,
            playerOn: _.get(event, 'swap[0].name'),
            playerOff: _.get(event, 'swap[1].name'),
            card: event.card,
            playerName: event.nameStr,
            isPenaltyShootoutEvent: event.isPenaltyShootoutEvent,
            assistInput: event.assistInput,
            minutesAddedTime: event.minutesAddedInput
        }
    });

    return _.orderBy(events, ['time'], ['asc']);
}

function getPenalties(matchDetails) {
    return _.map(_.get(matchDetails, 'content.matchFacts.events.penaltyShootoutEvents', []), (penalty) => {
        return {
            type: penalty.type,
            isHome: penalty.isHome,
            player: penalty.nameStr
        }
    });
}

module.exports = {
    getMatchDetails
};