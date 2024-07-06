const axios = require('axios');
const _ = require('lodash');

async function getMatchDetails(globals, matchId) {
    const url = `${globals.config.urls.matchDetailsApi.replace('{MATCHID}', matchId)}`;
    try {
        const response = await axios.get(url);
        return getMatchDetailsProcessed(response.data);
    } catch (error) {
        console.log(error);
        return null;
    }
}

function getMatchDetailsProcessed(matchDetails) {
    return {
        homeTeam: {
            events: getEvents(matchDetails, true),
            penalties: getPenalties(matchDetails, true),
        },
        awayTeam: {
            events: getEvents(matchDetails, false),
            penalties: getPenalties(matchDetails, false),
        }, 
    }
}

function getEvents(matchDetails, isHome) {
    console.log('Events:');
    console.log(_.get(matchDetails, 'content.matchFacts.events.events', []));
    let events = _.filter(_.get(matchDetails, 'content.matchFacts.events.events', []), (event) => {
        return event.isHome === isHome;
    });
    events = _.map(events, (event) => {
        return {
            time: event.time,
            type: event.type,
            ownGoal: event.ownGoal,
            goalDescription: event.goalDescription,
            playerOff : _.get(event, 'swap[0].name'),
            playerOn: _.get(event, 'swap[1].name'),
            card: event.card,
            playerName: event.nameStr,
            isPenaltyShootoutEvent: event.isPenaltyShootoutEvent,
            assistInput: event.assistInput
        }
    });

    return events;
}

function getPenalties(matchDetails, isHome) {
    console.log('Penalties:');
    console.log(_.get(matchDetails, 'content.matchFacts.events.penaltyShootoutEvents', []));
    let penalties = _.filter(_.get(matchDetails, 'content.matchFacts.events.penaltyShootoutEvents', []), (penalty) => {
        return penalty.isHome === isHome;
    });
    return _.map(penalties, (penalty) => {
        return {
            type: penalty.type,
            player: penalty.nameStr
        }
    });
}

module.exports = {
    getMatchDetails
};