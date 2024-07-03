const axios = require('axios');
const cheerio = require('cheerio');
const _ = require('lodash');
const globals = require('./globals');

async function init(globals) {
    
    let matchesOnTv = [];
    const url = globals.config.urls.matchesOnTv;

    try {
        const response = await axios.get(url);
        matchesOnTv = parseMatchesOnTv(response.data);
        console.info(`Got ${matchesOnTv.length} matches on TV from ${url}`);
    } catch (error) {
        console.error('Error getting football on TV:', error);
    } finally {
        globals.data.matchesOnTv = matchesOnTv;
    }
}

function parseMatchesOnTv(data) {
    const $ = cheerio.load(data);

    let matchesOnTv = [];
    let fixtureDate = undefined;

    // Iterate through all the divs in the page
    $('div').each((index, div) => {

        // If the div class name is "fixture-date", then get the date
        if ($(div).hasClass('fixture-date')) {
            fixtureDate = $(div).text();
        }

        // Otherwise, if the div class name is "fixture", then add it to the matchesOnTv array
        else if ($(div).hasClass('fixture')) {
            let match = {};

            // Set the match date
            _.set(match, 'fixture__date__text', fixtureDate);
            
            // Set the fixture time by finding the first div with a class name of "fixture__time"
            _.set(match, 'fixture__time', $(div).find('div[class*="fixture__time"]').first().text());

            // Set the fixture teams by finding the firstdiv with a class name of "fixture__teams"
            _.set(match, 'fixture__teams', $(div).find('div[class*="fixture__teams"]').first().text());

            // Set the fixture channel by finding the first span with a class name of "channel-pill"
            _.set(match, 'fixture__channel', $(div).find('span[class*="channel-pill"]').first().text());
            _.set(match, 'fixture__channel__fullname', $(div).find('span[class*="channel-pill"]').first().text());

            // Add the match to the matchesOnTv array
            matchesOnTv.push(match);
        }
       
    });

    return matchesOnTv;
}

module.exports = {
    init
}