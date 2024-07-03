const axios = require('axios');
axios.defaults.timeout = 10000;

const { parseString } = require('xml2js');

const _ = require('lodash');

const moment = require('moment');

let timeout;

// Returns an array of news items from the feeds configured under globals.config.news
// Note that we are only sourcing RSS feeds for now, but this may change at some point, hence the wrapper function
async function setNews(globals) {

    // console.info('Setting news...');

    const news = await getNewsRss(globals);
    if (news)
        _.set(globals, 'data.news', news);

    if (timeout)
        clearTimeout(timeout);
    timeout = setTimeout(() => {
        setNews(globals);
    }, globals.config.news.refreshIntervalMilliseconds);
}

// Returns an array of news items from the RSS feeds configured under globals.config.news.rss
async function getNewsRss(globals) {

    let stories = [];

    for (const category in globals.config.news.rss) {
        for (const feed of globals.config.news.rss[category]) {
            let storiesForFeed = [];
            const feedStories = await getRssStoriesJson(globals, category, feed.url);
            for (const feedStory of feedStories) {
                storiesForFeed.push({
                    category: category,
                    feed: feed,
                    story: feedStory
                });
                if (!feedStory) {
                    console.log(feedStories);
                    console.warn('Story is null:', feedStory, category, feed);
                    delete feedStory;
                }
            }
            // console.info(`Got ${feedStories.length} news stories for ${feed.title} from ${feed.url}`);

            stories = stories.concat(storiesForFeed);
        }
    }

    // Iterate over each feed in the stories array and remove any duplicates based on the story.title attribute
    stories = _.uniqBy(stories, feedStory => feedStory.story.title);

    // console.debug(`Got ${stories.length} news stories (after removing duplicates)`);

    return stories;

}

// Returns an array of news items from the given RSS feed URL
// Note that we call different functions based on the category
// to ensure that the correct data is extracted from the feed
// and the format is the same for each story
async function getRssStoriesJson(globals, category, url) {

    // Convert the XML to JSON
    const xmlResult = await getXml(url);
    const jsonResult = await parseXMLToJSON(xmlResult);
    return await getStoriesFromJson(globals, category, jsonResult);
}

// Use Axios to fetch the XML at the given URL
async function getXml(url) {
    return axios.get(url)
        .then(response => {
            return response.data;
        })
        .catch(error => {
            console.error(`Error fetching XML from ${url}:`, error);
            return null;
        });
}

// Parse the XML to JSON using the xml2js library
async function parseXMLToJSON(xmlResult) {
    try {

        return new Promise((resolve, reject) => {
            parseString(xmlResult, (err, result) => {
                if (err) {
                    console.error('Unable to convert XML to JSON', err);
                } else {
                    resolve(result);
                }
            });
        });
    } catch (error) {
        console.error('Error parsing XML to JSON:', error);
        return null;
    }
}

// Extracts the news items from the given RSS feed JSON
function getStoriesFromJson(globals, category, jsonResult) {
    try {
        let items = jsonResult.rss.channel[0].item;

        // Sort the stories by publish date to ensure we get the most recent stories
        items = items.map(item => {
            item.pubDate = moment(item.pubDate, 'ddd, DD MMM YYYY HH:mm:ss ZZ').toISOString();
            return item;
        });
        items = items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

        // Limit the number of stories per feed
        items = items.slice(0, globals.config.news.maxStoriesPerFeed);

        // Process each story
        return items.map(item => {
            const story = {};
            for (let key in item) {
                if (Array.isArray(item[key]) && item[key].length === 1) {
                    story[key] = item[key][0];
                } else {
                    story[key] = item[key];
                }
            }
            // Return the processed story
            return getStoryProcessed(category, story);
        });

    } catch (error) {
        console.error(`Error parsing JSON for ${category} story:`, error);
        return null;
    }
}

// Processes the given story
function getStoryProcessed(category, story) {

    // Add image URL and published date
    story.imageUrl = getImageUrl(category, story);

    // Strip any CDATA or HTML tags from the description
    if (story.description)
        story.description = story.description.replace(/<!\[CDATA\[(.*)\]\]>/, '$1').replace(/<[^>]*>/g, '');

    // Remove unnecessary data
    delete story['media:thumbnail'];
    delete story.guid;
    delete story['enclosure'];
    delete story.category;

    return story;

}

// Gets the image URL for the given story
function getImageUrl(category, story) {

    let imageTags = [
        'enclosure',
        'media:thumbnail',
        'media:content',
        'image'
    ];

    // Return the first image URL found in the story
    for (const tag of imageTags) {
        let imageUrl = _.get(story, `${tag}.$.url`);
        if (imageUrl)
            return imageUrl;
        // Otherwise, check if there is an array of images and if so, return the first one
        else {
            const imageArray = _.get(story, `${tag}`);
            if (Array.isArray(imageArray) && imageArray.length > 0) {
                imageUrl = _.get(imageArray[0], '$.url');
                if (imageUrl)
                    return imageUrl;
            }
        }
    }

    console.info(`No image URL found for ${category} story: ${story.title}`);
}

// Returns the news stories for the given user (device ID)
// TODO (future enhancement): Allow per-user customised news feed
function getNews(globals, deviceId) {
    return globals.data.news;
}

module.exports = {
    getNews,
    setNews
}