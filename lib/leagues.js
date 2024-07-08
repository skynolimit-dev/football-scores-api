const axios = require('axios');
const _ = require('lodash');

// Sets the leagues data
async function setLeagues(globals) {

    try {
        const response = await axios.get(globals.config.urls.leaguesApi);
        const leagues = response.data;

        for (const leagueCategory of Object.keys(leagues)) {

            // Add all popular leagues
            if (leagueCategory === 'popular') {
                globals.data.leagues = globals.data.leagues.concat(leagues[leagueCategory]);
            }
            else {
                // Otherwise, add leagues whose ID is in the includeOthers array
                if (leagues[leagueCategory] && leagues[leagueCategory].length > 0) {
                    for (const leagueData of leagues[leagueCategory]) {
                        const leaguesInCategory = _.get(leagueData, 'leagues', []);
                        if (leaguesInCategory.length > 0) {
                            for (const league of leaguesInCategory) {
                                if (globals.config.leagues.includeOthers.includes(league.id)) {
                                    globals.data.leagues.push(league);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Dedupe by ID
        globals.data.leagues = _.uniqBy(globals.data.leagues, 'id');

        // Add weight and isInternationalCompetition properties
        for (let league of globals.data.leagues) {
            league.weight = _.get(globals, `config.leagues.weights.${league.id}`, 0);
            league.isInternationalCompetition = _.includes(globals.config.leagues.international, league.id);
            league.isDefault = _.includes(globals.config.leagues.default, league.id);
        }

        // Order the leagues by ID
        globals.data.leagues = _.orderBy(globals.data.leagues, ['id'], ['asc']);


    } catch (error) {
        console.error('Error getting leagues:', error);
    }
}

module.exports = {
    setLeagues
}