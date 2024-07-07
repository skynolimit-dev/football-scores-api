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
        return {
            events: getEvents(matchDetails),
            penalties: getPenalties(matchDetails),
            url: _.get(matchDetails, 'content.matchFacts.postReview[0].shareUrl', null)
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