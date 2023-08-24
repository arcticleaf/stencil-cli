const async = require('async');
const utils = require('./stencil-push.utils');

function stencilPush(options = {}, callback) {
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
        ],
        callback,
    );
}

module.exports = stencilPush;
