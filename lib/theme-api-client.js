require('colors');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const NetworkUtils = require('./utils/NetworkUtils');
const { PACKAGE_INFO } = require('../constants');

const networkUtils = new NetworkUtils();

function storeHashError(message) {
    const error = new Error(message);
    error.name = 'StoreHashReadError';
    return error;
}

/**
 * @param {object} options
 * @param {string} options.storeUrl
 * @param {string} [options.storeHash]
 * @param {string} [options.configuredStoreHash]
 * @returns {Promise<string>}
 */
async function getStoreHash({ storeUrl, storeHash, configuredStoreHash }) {
    let storefront;
    try {
        storefront = new URL(storeUrl);
    } catch {
        throw storeHashError('normalStoreUrl must be a valid HTTP(S) URL.');
    }
    if (
        !['http:', 'https:'].includes(storefront.protocol) ||
        storefront.username ||
        storefront.password
    ) {
        throw storeHashError('normalStoreUrl must be an HTTP(S) URL without credentials.');
    }

    const isHash = (value) => typeof value === 'string' && /^[a-z0-9]+$/.test(value);
    const canonicalHost = storefront.hostname.match(
        /^store-([a-z0-9]+)(?:-\d+)?\.mybigcommerce\.com$/,
    );
    const urlHash = canonicalHost ? canonicalHost[1] : undefined;
    const hashes = [storeHash, configuredStoreHash, urlHash].filter((value) => value !== undefined);

    if (!hashes.every(isHash)) {
        throw storeHashError('storeHash must contain lowercase letters and numbers.');
    }
    if (new Set(hashes).size > 1) {
        throw storeHashError('storeHash conflicts with the selected store URL or configuration.');
    }
    if (hashes.length) {
        return hashes[0];
    }

    // Only custom domains without a configured hash need discovery.
    const discoveryUrl = new URL('/admin/oauth/info', storefront);
    discoveryUrl.protocol = 'https:';
    let response;
    try {
        response = await networkUtils.sendApiRequest({
            url: discoveryUrl.toString(),
            timeout: 10000,
            headers: { Accept: 'application/json' },
        });
    } catch {
        throw storeHashError(
            'Store discovery failed. Set storeHash in the selected Stencil config.',
        );
    }

    const contentType = (response.headers && response.headers['content-type']) || '';
    const isJson = /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(contentType);
    const body = response.data;
    if (
        !(response.status >= 200 && response.status < 300) ||
        !isJson ||
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        !isHash(body.store_hash)
    ) {
        throw storeHashError(
            'Store discovery returned an invalid response. Set storeHash in the selected Stencil config.',
        );
    }
    return body.store_hash;
}

/**
 * @param {object} options
 * @param {string} options.storeUrl
 * @param {string} [options.currentCliVersion]
 * @returns {Promise<object>}
 */
async function checkCliVersion({ storeUrl, _currentCliVersion = PACKAGE_INFO.version }) {
    const url = new URL(`/stencil-version-check?v=${'8.10.4'}`, storeUrl).toString();
    let payload;

    try {
        const response = await networkUtils.sendApiRequest({ url });
        payload = response.data;
        if (!payload) {
            throw new Error('Empty payload in the server response');
        }
    } catch (err) {
        /*
        throw new Error(
            'The BigCommerce Store you are pointing to either does not exist or is not available at this time.'
                .red +
                '\nError details:\n' +
                err.message,
        );
        */
    }
    if (payload.error) {
        throw new Error(payload.error.red);
    }
    if (payload.status !== 'ok') {
        throw new Error(
            'Error: You are using an outdated version of stencil-cli, please run '.red +
                '$ npm install -g @bigcommerce/stencil-cli'.cyan,
        );
    }
    return payload;
}

/**
 * @param {object} options
 * @param {string} options.variationId
 * @param {array} options.channelIds
 * @param {string} options.apiHost
 * @param {string} options.storeHash
 * @param {string} options.accessToken
 * @returns {Promise<Object[]>}
 */
async function activateThemeByVariationId({
    variationId,
    channelIds,
    apiHost,
    storeHash,
    accessToken,
}) {
    try {
        const promises = channelIds.map((id) =>
            networkUtils.sendApiRequest({
                url: `${apiHost}/stores/${storeHash}/v3/themes/actions/activate`,
                headers: {
                    'content-type': 'application/json',
                },
                method: 'POST',
                accessToken,
                data: {
                    variation_id: variationId,
                    channel_id: Number(id),
                    which: 'original',
                },
            }),
        );
        return Promise.all(promises);
    } catch (err) {
        err.name =
            err.response && err.response.status === 504
                ? 'VariationActivationTimeoutError'
                : 'VariationActivationError';
        throw err;
    }
}

/**
 * @param {object} options
 * @param {string} options.themeId
 * @param {string} options.accessToken
 * @param {string} options.apiHost
 * @param {string} options.storeHash
 * @returns {Promise<void>}
 */
async function deleteThemeById({ themeId, accessToken, apiHost, storeHash }) {
    return networkUtils.sendApiRequest({
        url: `${apiHost}/stores/${storeHash}/v3/themes/${themeId}`,
        accessToken,
        method: 'DELETE',
    });
}

/**
 * @param {object} options
 * @param {string} options.accessToken
 * @param {string} options.apiHost
 * @param {string} options.storeHash
 * @param {string} options.jobId
 * @param {Function} [options.resultFilter]
 * @returns {Promise<object>}
 */
async function getJob({ accessToken, apiHost, storeHash, jobId, resultFilter }) {
    let response;
    let payload;
    try {
        response = await networkUtils.sendApiRequest({
            url: `${apiHost}/stores/${storeHash}/v3/themes/jobs/${jobId}`,
            headers: {
                'cache-control': 'no-cache',
            },
            accessToken,
            validateStatus: () => true, // Wanna handle the statuses manually later
        });
        payload = response.data;
    } catch (err) {
        err.name = 'JobCompletionStatusCheckCaughtError';
        throw err;
    }

    if (response.status === 504) {
        console.log(
            'Found a status 504 - this seems to be a BC bug.',
            response.status,
            response.data,
        );

        response.status = 200;
        payload = {
            data: {
                id: jobId,
                time: new Date(),
                status: 'WORKING',
                percent_complete: 0,
                result: {},
                warnings: [],
                errors: [],
            },
        };
    }

    if (response.status !== 200 || (payload.data && payload.data.status === 'FAILED')) {
        const error = new Error('Job Failed');
        error.name = 'JobCompletionStatusCheckError';
        error.messages = (payload.data && payload.data.errors) || [{ message: payload.title }];
        throw error;
    }
    if (!payload.data || payload.data.status !== 'COMPLETED') {
        const error = new Error(payload.data.percent_complete);
        error.name = 'JobCompletionStatusCheckPendingError';
        throw error;
    }

    return resultFilter ? resultFilter(payload.data.result) : payload.data.result;
}

/**
 * @param {object} options
 * @param {string} options.accessToken
 * @param {string} options.apiHost
 * @param {string} options.storeHash
 * @returns {Promise<object[]>}
 */
async function getThemes({ accessToken, apiHost, storeHash }) {
    const response = await networkUtils.sendApiRequest({
        url: `${apiHost}/stores/${storeHash}/v3/themes`,
        accessToken,
    });
    return response.data.data;
}

/**
 * @param {object} options
 * @param {string} options.accessToken
 * @param {string} options.apiHost
 * @param {string} options.storeHash
 * @param {int} options.channelId
 * @returns {Promise<object[]>}
 */
async function getChannelActiveTheme({ accessToken, apiHost, storeHash, channelId }) {
    try {
        const response = await networkUtils.sendApiRequest({
            url: `${apiHost}/stores/${storeHash}/v3/channels/${channelId}/active-theme`,
            accessToken,
        });
        return response.data.data;
    } catch (err) {
        throw new Error(
            `Could not fetch active theme details for channel ${channelId}: ${err.message}`,
        );
    }
}

/**
 * @param {object} options
 * @param {string} options.accessToken
 * @param {string} options.apiHost
 * @param {string} options.storeHash
 * @returns {Promise<[{channel_id, url}]>}
 */
async function getStoreChannels({ accessToken, apiHost, storeHash }) {
    try {
        const response = await networkUtils.sendApiRequest({
            url: `${apiHost}/stores/${storeHash}/v3/sites`,
            accessToken,
        });
        return response.data.data;
    } catch (err) {
        throw new Error(`Could not fetch a list of the store channels: ${err.message}`);
    }
}

/**
 * @param {object} options
 * @param {string} options.accessToken
 * @param {string} options.apiHost
 * @param {string} options.storeHash
 * @param {string} options.themeId
 * @param {string} options.configurationId
 * @returns {Promise<object[]>}
 */
async function getThemeConfiguration({
    accessToken,
    apiHost,
    storeHash,
    themeId,
    configurationId,
}) {
    try {
        const response = await networkUtils.sendApiRequest({
            url: `${apiHost}/stores/${storeHash}/v3/themes/${themeId}/configurations?uuid:in=${configurationId}`,
            accessToken,
        });
        // If configurations array is empty, the theme ID was valid but the configuration ID was not
        if (!response.data || !response.data.data.length) {
            throw new Error(
                `Configuration ID ${configurationId} not found for theme ID ${themeId}`,
            );
        }
        return response.data.data[0];
    } catch (err) {
        throw new Error(`Could not fetch theme configuration: ${err.message}`);
    }
}

/**
 * @param {object} options
 * @param {string} options.themeId
 * @param {string} options.accessToken
 * @param {string} options.apiHost
 * @param {string} options.storeHash
 * @returns {Promise<object[]>}
 */
async function getVariationsByThemeId({ accessToken, apiHost, storeHash, themeId }) {
    try {
        const response = await networkUtils.sendApiRequest({
            url: `${apiHost}/stores/${storeHash}/v3/themes/${themeId}`,
            accessToken,
        });
        return response.data.data.variations;
    } catch (err) {
        err.name = 'VariationsRetrievalError';
        throw err;
    }
}

/**
 * @param {object} options
 * @param {string} options.bundleZipPath
 * @param {string} options.accessToken
 * @param {string} options.apiHost
 * @param {string} options.storeHash
 * @param {boolean} options.uploadBundleAgain
 * @returns {Promise<object>}
 */
async function postTheme({ bundleZipPath, accessToken, apiHost, storeHash, uploadBundleAgain }) {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(bundleZipPath), {
        filename: path.basename(bundleZipPath),
    });

    const response = await networkUtils.sendApiRequest({
        url: `${apiHost}/stores/${storeHash}/v3/themes`,
        method: 'POST',
        data: formData,
        headers: {
            ...formData.getHeaders(),
            'cache-control': 'no-cache',
        },
        accessToken,
        validateStatus: () => true, // Wanna handle the statuses manually later
    });
    const payload = response.data;

    if (response.status === 409) {
        // This status code is overloaded, so we need to check the message to determine
        // if we want to trigger the theme deletion flow.
        const uploadLimitPattern = /You have reached your upload limit/;
        if (
            payload &&
            payload.title &&
            uploadLimitPattern.exec(payload.title) &&
            !uploadBundleAgain
        ) {
            return { themeLimitReached: true };
        }

        const message =
            'You already have a theme upload in progress. You will need to wait for it to finish processing before uploading a new one.';
        throw new Error((payload && payload.title) || message);
    }

    if (response.status === 413) {
        const message =
            'Your theme bundle is too large. Please reduce the size of your assets to bring the zip file size under 50MB.';
        throw new Error((payload && payload.title) || message);
    }

    if (response.status !== 201) {
        throw new Error((payload && payload.title) || 'Server Error');
    }

    return { jobId: payload.job_id };
}

/**
 * @param {object} options
 * @param {string} options.accessToken
 * @param {string} options.apiHost
 * @param {string} options.storeHash
 * @param {string} options.themeId
 * @returns {Promise<{jobId: string}>}
 */
async function downloadTheme({ accessToken, apiHost, storeHash, themeId }) {
    try {
        const response = await networkUtils.sendApiRequest({
            url: `${apiHost}/stores/${storeHash}/v3/themes/${themeId}/actions/download`,
            headers: {
                'cache-control': 'no-cache',
                'content-type': 'application/json',
            },
            accessToken,
            method: 'POST',
            data: {
                which: 'last_activated',
            },
        });
        return {
            jobId: response.data.job_id,
        };
    } catch (err) {
        err.name = 'ThemeDownloadError';
        throw err;
    }
}

module.exports = {
    getStoreHash,
    checkCliVersion,
    activateThemeByVariationId,
    deleteThemeById,
    getStoreChannels,
    getChannelActiveTheme,
    getJob,
    getVariationsByThemeId,
    getThemes,
    getThemeConfiguration,
    postTheme,
    downloadTheme,
};
