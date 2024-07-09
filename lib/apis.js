const moment = require('moment');
const notifications = require('./notifications');

const _ = require('lodash');
const users = require('./users');
const logos = require('./logos');
const matchDetails = require('./matchDetails');

function serve(globals, matches, news, app) {

    // Healthcheck API endpoint - used by the app to check the server is up, and display
    // a big red banner to the user if it can't get a timely response
    app.get('/api/v1/healthcheck', (req, res) => {
        res.json({ status: 'ok' });
    });

    // ############### Begin debug APIs ###############

    // API endpoint to get the raw (pre-processing) matches data - for debugging only
    app.get('/api/v1/debug/matches/raw', async (req, res) => {
        res.json(globals.data.matches);
    });

    // API endpoint to get all the (processed) matches - for debugging only
    app.get('/api/v1/debug/matches/all', async (req, res) => {
        res.json(matches.getAllMatches(globals));
    });

    // API endpoint to get the notifications history - for debugging only
    app.get('/api/v1/debug/notifications', async (req, res) => {
        res.json(await notifications.getAll());
    });

    // API endpoint to send a test notification to the given device ID - for debugging only
    app.post('/api/v1/debug/notifications/test/user/:deviceId', async (req, res) => {
        const succeeded = await notifications.sendTestNotification(req.params.deviceId);
        res.json({ succeeded: succeeded });
    });

    // API endpoint to get all user data - for debugging only
    app.get('/api/v1/debug/users', async (req, res) => {
        res.json(await users.getAll());
    });

    // API endpoint to get leagues data - for debugging only
    app.get('/api/v1/debug/leagues', async (req, res) => {
        res.json(globals.data.leagues);
    });

    // API endpoint to get the match parsing info - for debugging only
    app.get('/api/v1/debug/parseInfo', (req, res) => {
        res.json(globals.data.parseInfo);
    });

    // API endpoint to get matches in play - for debugging only
    app.get('/api/v1/debug/matches/inPlay', (req, res) => {
        res.json(globals.data.matchesInPlay);
    });

    // API endpoint to get a match by ID - for debugging only
    app.get('/api/v1/debug/match/:matchId', (req, res) => {
        res.json(matches.getMatchById(globals, req.params.matchId));
    });

    // API endpoint to get the cache - for debugging only
    app.get('/api/v1/debug/cache', (req, res) => {
        res.json(globals.data.cache);
    });

    // API endpoint to get the top teams - for debugging only
    app.get('/api/v1/debug/teams/top', (req, res) => {
        res.json(globals.data.topTeams);
    });

    // API endpoint to get the team ratings - for debugging only
    app.get('/api/v1/debug/teams/ratings', (req, res) => {
        res.json(globals.data.ratings);
    });

    // API endpoint to get the matches on TV - for debugging only
    app.get('/api/v1/debug/matches/onTv', (req, res) => {
        res.json(globals.data.matchesOnTv);
    });

    // API endpoint to get the matches on TV - for debugging only
    app.get('/api/v1/debug/matches/proxy', (req, res) => {
        res.json(globals.data.matches.filter(match => match.isProxy));
    });

    // API endpoint to get user notification details - for debugging only
    app.get('/api/v1/debug/notifications/info/user/:deviceId', async (req, res) => { 
        res.json(await notifications.getUserNotificationDetails(globals, req.params.deviceId));
    });

    // API endpoint to get server system data - for debugging only
    app.get('/api/v1/debug/system', (req, res) => {
        res.json(globals.data.system);
    });

    // ############### End debug APIs ###############



    // ############### Begin user (device) facing APIs ###############

    // API endpoint to get fixtures for a user, i.e. all matches yet to kick off
    app.get('/api/v1/user/:deviceId/matches/fixtures', async (req, res) => {
        res.json(await matches.getFixtures(globals, req.params.deviceId, req.query.limit));
    });

    // API endpoint to get default fixtures (used by the widget)
    app.get('/api/v1/matches/fixtures', async (req, res) => {
        res.json(await matches.getFixtures(globals, 'default', req.query.limit, true));
    });

    // API endpoint to get today's and upcoming (future) matches that are on TV
    app.get('/api/v1/user/:deviceId/matches/onTv', async (req, res) => {
        res.json(await matches.getMatchesOnTv(globals, req.params.deviceId));
    });

    // API endpoint to get results for a user, i.e. all matches that have finished
    app.get('/api/v1/user/:deviceId/matches/results', async (req, res) => {
        res.json(await matches.getResults(globals, req.params.deviceId, req.query.limit));
    });

    // API endpoint to get default results (used by the widget)
    app.get('/api/v1/matches/results', async (req, res) => {
        res.json(await matches.getResults(globals, 'default', req.query.limit, true));
    });

    // API endpoint to get default results (used by the widget)
    app.get('/api/v1/match_details/match/:matchId', async (req, res) => {
        res.json(await matchDetails.getMatchDetails(globals, req.params.matchId));
    });

    // API endpoint to get fixtures for the given user's predictor games
    // Note that the predictor games themselves are played client-side, and this endpoint
    // is simply to return the list of games
    app.get('/api/v1/user/:deviceId/matches/predictor', async (req, res) => {
        res.json(await matches.getFixtures(globals, req.params.deviceId));
    });

    // API endpoint to get the news
    app.get('/api/v1/user/:deviceId/news', (req, res) => {
        res.json(news.getNews(globals, req.params.deviceId));
    });

    // API endpoint to get the user data for the given user (device) ID
    app.get('/api/v1/user/:deviceId', async (req, res) => {
        const user = await users.get(req.params.deviceId);
        if (user)
            res.json(user);
        else
            res.status(404).json({ error: 'User info not found' });
    });

    // API endpoint to update/set the user and device info for the given user (device) ID
    app.put('/api/v1/user/:deviceId/userDeviceInfo', async (req, res) => {
        res.json({success: await users.set(globals, req.body, req.params.deviceId)});
    });

    // API endpoint to update/set the user preferences for the given user (device) ID
    app.put('/api/v1/user/:deviceId/preferences', async (req, res) => {
        const success = await users.setPreferences(globals, req.body, req.params.deviceId);
        await matches.setMatchesOfInterestForUser(globals, req.params.deviceId);
        res.json({success: success});
    });

    // TODO: Remove
    // API endpoint to delete the data for a specific user device
    // app.delete('/api/v1/user/:deviceId', (req, res) => {
    //     res.json(users.deleteData(globals, req.params.deviceId));
    // });

    // API endpoint to post a test user push notification
    app.post('/api/v1/user/notifications/test', async (req, res) => {
        const succeeded = await notifications.test(globals, req.body);
        const statusCode = succeeded ? 200 : 500;
        res.status(statusCode).json({ success: succeeded });
    });

    // API endpoint to register a user's device token for push notifications
    app.post('/api/v1/user/notifications/register', (req, res) => {
        const succeeded = notifications.register(globals, req.body);
        const statusCode = succeeded ? 200 : 500;
        res.status(statusCode).json({ success: succeeded });
    });

    // API endpoint to get competition names
    // TODO (future enhancement): - have the app use this to get the competition names for the user's preferred competitions
    app.get('/api/v1/competitions', (req, res) => {
        res.json(matches.getCompetitions(globals));
    });

    // API endpoint to get all club teams
    // Used by the app to allow users to choose which club teams to follow
    app.get('/api/v1/teams/club', (req, res) => {
        res.json(matches.getTeams(globals, 'club'));
    });
    
    // API endpoint to get all international teams
    // Used by the app to allow users to choose which international teams to follow
    app.get('/api/v1/teams/international', (req, res) => {
        res.json(matches.getTeams(globals, 'international'));
    });

    // API endpoint to get the logo image path for the given team
    app.get('/api/v1/teams/:teamName/logo', (req, res) => {
        res.json({ logoPath: logos.getTeamLogoPath(req.params.teamName) });
    });
    
    // API endpoint to get the logo image path for the given TV channel
    app.get('/api/v1/tv/:channelName/logo', (req, res) => {
        res.json({ logoPath: logos.getTvChannelLogoPath(req.params.channelName) });
    });
}

module.exports = {
    serve
}