const async = require('async');
const utils = require('./stencil-push.utils');

function stencilPush(options = {}, callback) {
    const channelSteps = [];

    if (options && options.channelIds) {
        channelSteps.push(utils.promptUserWhetherToApplyTheme);
        channelSteps.push(utils.getVariations);
        channelSteps.push(utils.requestToApplyVariationWithRetrys());
        channelSteps.push(utils.notifyUserOfCompletion);
    }

    async.waterfall(
        [
            async.constant(options),
            utils.readStencilConfigFile,
            utils.getStoreHash,
            utils.getThemes,
            utils.generateBundle,
            utils.uploadBundle,
            utils.notifyUserOfThemeLimitReachedIfNecessary,
            utils.promptUserToDeleteThemesIfNecessary,
            utils.deleteThemesIfNecessary,
            utils.checkIfDeletionIsComplete(),
            utils.uploadBundleAgainIfNecessary,
            utils.notifyUserOfThemeUploadCompletion,
            utils.pollForJobCompletion((data) => ({ themeId: data.theme_id })),
            ...channelSteps,
        ],
        callback,
    );
}

module.exports = stencilPush;
