const axios = require('axios');

axios.defaults.headers = {
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Expires': '0',
  };

async function getWidget(globals, deviceId, widgetCategory, tvOnly) {

    // Set the widget source URI
    const widgetUri = globals.config.urls.widget.sourceUri.replace('{CATEGORY}', widgetCategory);

    console.log('Getting widget source:', widgetUri);

    // Get the widget source
    try {
        const response = await axios.get(widgetUri);
        console.log('Response:', response);
        let widgetSource = response.data;

        console.log('Widget source:', widgetSource);

        // Replace the '{DEVICE_ID}' variable with the device ID
        widgetSource = widgetSource.replace('{__DEVICE_ID__}', deviceId);

        // Replace the '{TV_ONLY}' variable with the tvOnly flag
        widgetSource = widgetSource.replace('{__TV_ONLY__}', tvOnly);

        return widgetSource;
    } catch (error) {
        console.log(error.status);
        return;
    }

}

module.exports = {
    getWidget
}