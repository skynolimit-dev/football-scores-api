const fs = require('fs');
const path = require('path');
const logosDir = path.join(__dirname, '../public/icons');
const teamLogosUriPrefix = '/icons/team-logos';
const tvChannelLogosUriPrefix = '/icons/tv-channel-logos';

function getTeamLogoPath(teamName) {

    if (doesFileExist(`${teamName}.png`))
        return `${teamLogosUriPrefix}/${teamName}.png`;
    else
        return `${teamLogosUriPrefix}/_noLogo.png`;

}

function doesFileExist(file) {
    return fs.existsSync(path.join(logosDir, 'team-logos', file));
}

function getTvChannelLogoPath(channelName) {
    channelName = channelName.toLowerCase();
    if (channelName.includes('amazon')) return `${tvChannelLogosUriPrefix}/amazon.png`;
    else if (channelName.includes('apple')) return `${tvChannelLogosUriPrefix}/apple.png`;
    else if (channelName.includes('bbc')) return `${tvChannelLogosUriPrefix}/bbc.png`;
    else if (channelName.includes('channel 4')) return `${tvChannelLogosUriPrefix}/channel 4.png`;
    else if (channelName.includes('discovery')) return `${tvChannelLogosUriPrefix}/discovery.png`;
    else if (channelName.includes('itv')) return `${tvChannelLogosUriPrefix}/itv.png`;
    else if (channelName.includes('sky')) return `${tvChannelLogosUriPrefix}/sky.png`;
    else if (channelName.includes('tnt')) return `${tvChannelLogosUriPrefix}/tnt.png`;
    else return `${tvChannelLogosUriPrefix}/_noLogo.png`;
}

module.exports = {
    getTeamLogoPath,
    getTvChannelLogoPath
}