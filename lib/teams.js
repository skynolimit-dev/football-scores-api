const axios = require('axios');
axios.defaults.timeout = 10000;

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const _ = require('lodash');

// Returns the team ratings for club and national teams
async function setRatings(globals) {

    try {
        let ratingsClub = await getRatingsClub(globals);
        let ratingsNational = await getRatingsNational(globals);

        // If we didn't get sensible data, try the contingency data
        if (!ratingsClub || ratingsClub.length < 600)
            ratingsClub = await getRatingsClubContingencyData(globals);
        if (!ratingsNational || ratingsNational.length < 200)
            ratingsNational = await getRatingsNationalContingencyData(globals);

        // Add any custom config entries
        ratingsClub = ratingsClub.concat(globals.config.teams.ratings.club);
        ratingsNational = ratingsNational.concat(globals.config.teams.ratings.national);

        // Only update the ratings if it looks like we got a sensible amount of data
        if (ratingsClub && ratingsClub.length > 600) {
            console.info('Setting club ratings for', ratingsClub.length, 'teams');
            _.set(globals, 'data.ratings.club', ratingsClub);
        }
        if (ratingsNational && ratingsNational.length > 200)
            _.set(globals, 'data.ratings.national', ratingsNational);

        // Calculate which entry is higher, and store it in the globals object
        // We store this to help calculate scoring changes for the predictor
        const firstClubRating = ratingsClub[0];
        const firstNationalRating = ratingsNational[0];
        const highestRatedTeam = firstClubRating.rating > firstNationalRating.rating ? firstClubRating : firstNationalRating;
        _.set(globals, 'data.ratings.max', parseInt(highestRatedTeam.rating));
    } catch (error) {
        console.error('Unable to set max rating, no data found')
    }

}

// Returns an array of team ratings from the Club Elo API (http://clubelo.com/)
// TODO: Handle failures better
async function getRatingsClub(globals) {

    let ratings = [];

    const url = globals.config.urls.ratings.club.data.replace('{YYYY-MM-DD}', new Date().toISOString().split('T')[0]);

    try {

        // Load the team ratings data, which is a CSV download from Club Elo
        const response = await axios.get(url);
        const data = response.data;
        ratings = getRatingsClubFromCsv(data);
        console.info(`Got ${ratings.length} club team ratings from ${url}`);

    } catch (error) {
        console.error(`Error parsing club team ratings from ${url}:`, error);
    } finally {
        return ratings;
    }

}

// Returns an array of club team ratings CSV data
function getRatingsClubFromCsv(data) {

    let ratings = [];

    try {
        // Convert the CSV data to an array of objects
        ratings = data.split('\n').map(line => {
            const parts = line.split(',');
            return {
                team: parts[1],
                rating: parseFloat(parts[4])
            }
        });

        // Remove the first element, which is the header row
        ratings.shift();
        ratings = ratings.filter(rating => rating.team && rating.rating);
    } catch (error) {
        console.error('Error parsing club team ratings from CSV data:', error);
    } finally {
        return ratings;
    }

}

// Returns an array of club team ratings from the contingency data
// Only used if the Club Elo API is down
async function getRatingsClubContingencyData() {

    console.warn('Getting contingency club team ratings');

    let ratings = [];

    // Get the latest file in the directory
    try {
        const dir = path.join(__dirname, `../assets/contingency_data/ratings/club`);
        const latestFile = fs.readdirSync(dir).sort().reverse()[0];
        const filePath = path.join(dir, latestFile);
        const data = fs.readFileSync(filePath, 'utf8');
        ratings = getRatingsClubFromCsv(data);
        console.info(`Got ${ratings.length} club team ratings from ${filePath}`);
    } catch (error) {
        console.error(`Error parsing contingency club team ratings:`, error);
    } finally {
        return ratings;
    }

}


// Returns an array of team ratings from the World Football Elo website (http://eloratings.net/)
// TODO: Handle failures better
async function getRatingsNational(globals) {

    // First get the mapping of team codes to names (e.g. "ENG" -> "England")
    const teamNames = await getTeamNamesNational(globals);

    let ratings = [];
    const url = globals.config.urls.ratings.national.data;

    try {
        const response = await axios.get(url);
        const data = response.data;
        ratings = getRatingsDataNationalFromTsv(data, teamNames);
        console.info(`Got ${ratings.length} national team ratings from ${url}`);
    } catch (error) {
        console.error(`Error parsing national team ratings from ${url}:`, error);
    } finally {
        return ratings;
    }

}

// Returns an array of national team ratings from the contingency data
// Only used if the World Football Elo website is down
async function getRatingsNationalContingencyData() {

    console.warn('Getting contingency national team ratings');

    // First get the mapping of team codes to names (e.g. "ENG" -> "England")
    const teamNames = getTeamNamesNationalContingencyData();

    let ratings = [];
    const filePath = path.join(__dirname, '../assets/contingency_data/ratings/national/World.tsv');

    try {
        // Load the TSV data from ../assets/contingency_data/ratings/national/World.tsv
        const data = fs.readFileSync(filePath, 'utf-8');
        ratings = getRatingsDataNationalFromTsv(data, teamNames);
        console.info(`Got ${ratings.length} national team ratings from ${filePath}`);
    } catch (error) {
        console.error(`Error parsing national team ratings from ${filePath}:`, error);
    } finally {
        return ratings;
    }

}

function getTeamNamesNationalContingencyData() {

    let teamNames = [];

    const filePath = path.join(__dirname, '../assets/contingency_data/ratings/national/en.teams.tsv');

    try {
        const data = fs.readFileSync(filePath, 'utf-8');
        teamNames = getTeamNamesFromTsvData(data);
        console.info(`Got ${teamNames.length} national team names from ${filePath}`);

    } catch (error) {
        console.error(`Error parsing national team names from ${filePath}:`, error);
    } finally {
        return teamNames;
    }

}



// Returns an array of national team names and ratings from the source TSV data
function getRatingsDataNationalFromTsv(data, teamNames) {

    let ratings = [];

    try {

        // Convert the TSV data to an array of objects
        ratings = data.split('\n').map(line => {
            const parts = line.split('\t');
            return {
                team: parts[2],
                rating: parseFloat(parts[3])
            }
        });

        // Remove the first element, which is the header row
        ratings.shift();

        // Add the team names to the ratings
        ratings.forEach(rating => {
            const teamName = teamNames.find(team => team.team === rating.team);
            if (teamName)
                rating.team = teamName.name;
            else
                console.warn('No national team name found for', rating.team);
        });

    } catch (error) {
        console.error('Error parsing national team ratings from TSV data:', error);
    } finally {
        return ratings;
    }

}


// Returns an array of team names from the World Football Elo website (http://eloratings.net/)
async function getTeamNamesNational(globals) {

    let teamNames = [];
    const url = globals.config.urls.ratings.national.teamNames;

    try {
        const response = await axios.get(url);
        const data = response.data;
        teamNames = getTeamNamesFromTsvData(data);
        console.info(`Got ${teamNames.length} national team names from ${url}`);

    } catch (error) {
        console.error(`Error parsing national team names from ${url}:`, error);
    } finally {
        return teamNames;
    }

}

function getTeamNamesFromTsvData(data) {

    try {
        // Convert the TSV data to an array of objects
        teamNames = data.split('\n').map(line => {
            const parts = line.split('\t');
            return {
                team: parts[0],
                name: parts[1]
            }
        });

        // Remove the first element, which is the header row
        teamNames.shift();
    } catch (error) {
        console.error('Error parsing team names from TSV data:', error);
    } finally {
        return teamNames;
    }

}


// Returns an array of "top" teams, i.e. top flight teams and top European clubs
// This list of teams is used to filter out fixtures not involving top flight
// clubs for competitions such as the Europa League where otherwise the number
// of games would be unmanageable
// TODO: Use elo ratings to determine top teams
async function setTopTeams(globals) {

    let teams = [];

    // Get top flight Premier League teams
    teams = await getTopFlightTeams(globals);

    // Then, get all club teams with an ELO rating of 1500 or greater
    const clubRatings = globals.data.ratings.club;
    const minClubEloRating = globals.config.teams.topTeamsMinClubEloRating;
    if (clubRatings)
        teams = teams.concat(clubRatings.filter(rating => rating.rating >= minClubEloRating).map(rating => rating.team));

    // Dedupe the team names by alias
    teams = dedupeByAlias(globals, teams);

    globals.data.topTeams = teams.sort();

}

function dedupeByAlias(globals, teamNames) {
    let duplicateTeamNames = [];

    for (const teamName of teamNames) {
        for (const aliasArray of globals.config.teams.aliases) {
            if (aliasArray.includes(teamName)) {
                // Push all aliases except the first one to the duplicates array
                // so that we can remove them from the original array, as they
                // are duplicates
                aliasArray.slice(1).forEach(alias => duplicateTeamNames.push(alias));
            }
        }
    }

    // Remove all the duplicate team names from the original array
    const dedupedTeamNames = teamNames.filter(teamName => !duplicateTeamNames.includes(teamName));

    return _.uniq(dedupedTeamNames).sort();
}

// Sets an array of all the teams found in the BBC Sport Premier League table
async function getTopFlightTeams(globals) {

    let teams = [];
    const url = globals.config.urls.topFlightTeamsTables;

    try {

        // Load the top flight teams data
        const response = await axios.get(url);
        const html = response.data;
        const $ = cheerio.load(html);

        // Iterate over each row and add the team name
        $('tbody tr[class*="TableRow"]').each((index, row) => {
            const displayName = $(row).find('a').first();
            if (displayName)
                teams.push(displayName.text());
        });

        console.info(`Got ${teams.length} top flight teams from ${url}`);

    } catch (error) {
        console.error(`Error parsing top flight teams from ${url}:`, error);
    } finally {
        return teams;
    }

}


module.exports = {
    setRatings,
    setTopTeams
}