const os = require('os');
const { userPreferencesCache } = require('./users');

const hostname = os.hostname();

// Config
const config = {
    competitions: require('../config/competitions.json'),
    domains: require('../config/domains.json'),
    leagues: require('../config/leagues.json'),
    news: require('../config/news.json'),
    notifications: require('../config/notifications.json'),
    parsing: require('../config/parsing.json'),
    predictor: require('../config/predictor.json'),
    server: require('../config/server.json'),
    teams: require('../config/teams.json'),
    urls: require('../config/urls.json'),
    user: require('../config/user.json')
}

// Global data objects
let data = {
    matchCategories: [
        "nowAndUpcoming",
        "onTv",
        "past"
    ],
    userPreferencesCache: {},
    leagues: [],
    matches: [],
    predictorMatches: {},
    news: {},
    teams: {
        club: [],
        international: []
    },
    topTeams: [],
    matchesOnTv: [],
    parseInfo: {
        summary: {},
        details: {}
    },
    notifications: [],
    users: [],
    system: {
        memoryProfiles: []
    }
}

// Server info
const server = {
    protocol: hostname.includes('.local') ? 'http' : 'https',
    domain: hostname.includes('.local') ? `${hostname}:${config.server.port}` : config.domains.production,
    hostname: hostname,
    port: process.env.PORT || config.server.port
}

module.exports = {
    config,
    data,
    server
}