const express = require('express');
const cors = require('cors');
const app = express();
app.use(require('express-status-monitor')());
app.use(cors()); // Enable CORS for all routes

const globals = require('./lib/globals');
const leagues = require('./lib/leagues');
const teams = require('./lib/teams');
const matches = require('./lib/matches');
const matchesOnTv = require('./lib/matchesOnTv');
const news = require('./lib/news');
const predictor = require('./lib/predictor');
const apis = require('./lib/apis');
const db = require('./lib/db');
const user = require('./lib/users');
const { setLeagues } = require('./lib/leagues');

app.use(express.static('public'));
app.use(express.json());

// Set globals (reload data every hour)
async function setGlobals() {

  try {
    // Set team ratings first as this determines the top teams
    await teams.setRatings(globals);
    // Then do everything else in parallel
    await Promise.all([
      leagues.setLeagues(globals),
      teams.setTopTeams(globals),
      matchesOnTv.init(globals),
      news.setNews(globals)
    ]);

  } catch (error) {
    console.error('Error setting globals:', error);
  }

  // Repeeat every hour
  setTimeout(() => {
    setGlobals();
  }, 60 * 60 * 1000);

}


async function main() {

  // Print server info
  console.info('NODE_ENV: ', process.env.NODE_ENV);

  db.set('server', 'last_startup', {
    startup_time: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });

  await setGlobals();

  // Serve up those tasty APIs (note we may not necessarily have any match data yet, but hey)
  apis.serve(globals, matches, news, app, predictor);

  // Set the match data
  await matches.setMatchData(globals);

  // Set the user preferences watcher
  // This updates the matches of interest for the user if they update their preferences
  user.initUserPreferencesWatcher(globals, matches.setMatchesOfInterestForUser);

  // Send a server startup notiification
  const notifications = require('./lib/notifications');
  notifications.sendServerStartupNotification();

  // Start the web server
  app.listen(globals.server.port, () => {
    console.info(`Server is running on port ${globals.server.port}`);
  });

}


main();