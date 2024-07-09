const os = require('os');

const hostname = os.hostname();

// Config
const config = {
    competitions: require('../config/competitions.json'),
    domains: require('../config/domains.json'),
    leagues: require('../config/leagues.json'),
    news: require('../config/news.json'),
    notifications: require('../config/notifications.json'),
    parsing: require('../config/parsing.json'),
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
    leagues: [],
    matches: [],
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
    },
    cache: {
        userPreferences: {},
        userInfo: {}
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