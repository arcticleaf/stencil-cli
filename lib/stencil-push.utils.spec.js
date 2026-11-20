const axios = require('axios');
const MockAdapter = require('axios-mock-adapter');

const {
    getStoreHash,
    promptUserForChannel,
    promptUserForChannels,
    promptUserToSelectChannels,
    getChannels,
} = require('./stencil-push.utils');
const utils = require('./stencil-push.utils');
const themeApiClient = require('./theme-api-client');

const axiosMock = new MockAdapter(axios);

describe('stencil push utils', () => {
    const mockConfig = {
        normalStoreUrl: 'https://www.example.com',
        port: 4000,
        accessToken: 'accessTokenValue',
    };
    const optionsApplyThemeIsFalse = {
        config: { accessToken: 'asdasd33' },
        applyTheme: false,
        apiHost: 'abc2342',
    };
    const optionsApplyThemeIsTrueAndChannels = {
        config: { accessToken: 'asdasd33' },
        applyTheme: true,
        channelIds: [1, 2],
    };
    const optionsResult = {
        applyTheme: true,
        apiHost: 'abc2342',
        allChannels: true,
        channels: [
            {
                url: 'https://abc.com',
                channel_id: 1,
            },
            {
                url: 'https://fff.com',
                channel_id: 2,
            },
        ],
        channelIds: [1, 2],
    };

    beforeEach(() => {
        jest.spyOn(console, 'info').mockImplementation(jest.fn());
    });

    afterEach(() => {
        jest.restoreAllMocks();
        axiosMock.reset();
        jest.clearAllMocks();
    });

    describe('.getStoreHash()', () => {
        it('should get the store hash', async () => {
            const mockResponseData = {
                store_hash: 'abc123',
            };
            axiosMock.onGet().reply(200, mockResponseData, {
                'content-type': 'application/json; charset=utf-8',
            });

            const result = await getStoreHash({ config: mockConfig });

            expect(result.storeHash).toEqual(mockResponseData.store_hash);
            expect(result.config.normalStoreUrl).toEqual(mockConfig.normalStoreUrl);
        });

        it('should return an error if it fails to retrieve the store hash', async () => {
            const mockResponseData = {};
            axiosMock.onGet().reply(200, mockResponseData, {
                'content-type': 'application/json',
            });

            await expect(getStoreHash({ config: mockConfig })).rejects.toThrow(
                'Store discovery returned an invalid response',
            );
        });

        it('uses a configured hash for a custom domain without discovery', async () => {
            const config = { ...mockConfig, storeHash: 'abc123' };

            await expect(getStoreHash({ config })).resolves.toEqual({
                config,
                storeHash: 'abc123',
            });
            expect(axiosMock.history.get).toHaveLength(0);
        });

        it.each([
            'http://store-gqwzrjenci.mybigcommerce.com',
            'https://store-gqwzrjenci-1793165.mybigcommerce.com',
        ])('derives the store hash from %s without discovery', async (normalStoreUrl) => {
            const config = { ...mockConfig, normalStoreUrl, channelIds: [1, 1793165, 1835505] };

            await expect(getStoreHash({ config })).resolves.toEqual({
                config,
                storeHash: 'gqwzrjenci',
            });
            expect(axiosMock.history.get).toHaveLength(0);
        });

        it('accepts matching configured and canonical hashes', async () => {
            const config = {
                ...mockConfig,
                normalStoreUrl: 'https://store-abc123.mybigcommerce.com',
                storeHash: 'abc123',
            };

            await expect(getStoreHash({ config })).resolves.toHaveProperty('storeHash', 'abc123');
            expect(axiosMock.history.get).toHaveLength(0);
        });

        it('rejects a configured hash that conflicts with the store URL', async () => {
            const config = {
                ...mockConfig,
                normalStoreUrl: 'https://store-other123.mybigcommerce.com',
                storeHash: 'abc123',
            };

            await expect(getStoreHash({ config })).rejects.toThrow('storeHash conflicts');
            expect(axiosMock.history.get).toHaveLength(0);
        });

        it('rejects a forwarded hash that conflicts with a custom-domain config', async () => {
            const config = { ...mockConfig, storeHash: 'abc123' };

            await expect(getStoreHash({ config, storeHash: 'other123' })).rejects.toThrow(
                'storeHash conflicts',
            );
            expect(axiosMock.history.get).toHaveLength(0);
        });

        it.each(['', ' ', 'ABC123', 'abc/123', null, 123])(
            'rejects malformed configured hash %p instead of silently using the URL',
            async (storeHash) => {
                const config = {
                    ...mockConfig,
                    normalStoreUrl: 'https://store-abc123.mybigcommerce.com',
                    storeHash,
                };

                await expect(getStoreHash({ config })).rejects.toMatchObject({
                    name: 'StoreHashReadError',
                });
                expect(axiosMock.history.get).toHaveLength(0);
            },
        );

        it.each([
            'not a URL',
            'ftp://store-abc123.mybigcommerce.com',
            'https://user:password@www.example.com',
        ])('rejects an invalid storefront URL %s', async (normalStoreUrl) => {
            await expect(
                getStoreHash({ config: { ...mockConfig, normalStoreUrl, storeHash: 'abc123' } }),
            ).rejects.toMatchObject({ name: 'StoreHashReadError' });
            expect(axiosMock.history.get).toHaveLength(0);
        });

        it('discovers once and reuses the result for subsequent bundle/push calls', async () => {
            const config = {
                ...mockConfig,
                normalStoreUrl: 'http://www.example.com/some/path',
                channelIds: [1, 1793165, 1835505],
            };
            axiosMock
                .onGet('https://www.example.com/admin/oauth/info')
                .reply(200, { store_hash: 'abc123' }, { 'content-type': 'application/json' });

            const preflight = await getStoreHash({ config });
            const bundle = await getStoreHash(preflight);
            const push = await getStoreHash(bundle);

            expect(push).toEqual({ config, storeHash: 'abc123' });
            expect(axiosMock.history.get).toHaveLength(1);
        });

        it('does not treat a lookalike hostname as a canonical store URL', async () => {
            const normalStoreUrl = 'https://store-wrong.mybigcommerce.com.example.com';
            axiosMock
                .onGet(`${normalStoreUrl}/admin/oauth/info`)
                .reply(200, { store_hash: 'actual123' }, { 'content-type': 'application/json' });

            await expect(
                getStoreHash({ config: { ...mockConfig, normalStoreUrl } }),
            ).resolves.toHaveProperty('storeHash', 'actual123');
            expect(axiosMock.history.get).toHaveLength(1);
        });

        it.each([200, 403])('rejects Cloudflare HTML with HTTP %i', async (status) => {
            axiosMock
                .onGet()
                .reply(status, '<html>Just a moment...</html>', { 'content-type': 'text/html' });

            await expect(getStoreHash({ config: mockConfig })).rejects.toMatchObject({
                name: 'StoreHashReadError',
                message: expect.stringContaining('Set storeHash'),
            });
        });

        it.each([[], null, {}, { store_hash: 123 }, { store_hash: 'abc/123' }])(
            'rejects invalid discovery payload %p',
            async (payload) => {
                axiosMock.onGet().reply(200, payload, { 'content-type': 'application/json' });

                await expect(getStoreHash({ config: mockConfig })).rejects.toThrow(
                    'Store discovery returned an invalid response',
                );
            },
        );

        it('does not expose raw network error details', async () => {
            axiosMock.onGet().reply(() => Promise.reject(new Error('sensitive request details')));

            await expect(getStoreHash({ config: mockConfig })).rejects.toMatchObject({
                name: 'StoreHashReadError',
                message: 'Store discovery failed. Set storeHash in the selected Stencil config.',
            });
        });
    });

    describe('.getChannels', () => {
        it('should return options when applyTheme is false', async () => {
            const result = await getChannels(optionsApplyThemeIsFalse);
            expect(result).toEqual(optionsApplyThemeIsFalse);
        });

        it('should return options when applyTheme is true and channelIds available', async () => {
            const result = await getChannels(optionsApplyThemeIsTrueAndChannels);
            expect(result).toEqual(optionsApplyThemeIsTrueAndChannels);
        });

        it('should call getStoreChannels', async () => {
            const options = {
                applyTheme: true,
                config: {
                    accessToken: 'asdasdqweq',
                },
            };
            const spy = jest.spyOn(themeApiClient, 'getStoreChannels').mockReturnValue([]);

            await getChannels(options);

            expect(spy).toHaveBeenCalled();
        });
    });

    describe('.promptUserForChannel', () => {
        const mockPromptUserToSelectChannel = jest
            .spyOn(utils, 'promptUserToSelectChannel')
            .mockReturnValue({});

        it('should return options when applyTheme is false and no channelIds available', async () => {
            const result = await promptUserForChannel(optionsApplyThemeIsFalse);

            expect(mockPromptUserToSelectChannel).toHaveBeenCalledTimes(0);
            expect(result).toEqual(optionsApplyThemeIsFalse);
        });

        it('should call promptUserToSelectChannel when applyTheme is true and no channelIds available', async () => {
            const options = {
                applyTheme: true,
                apiHost: 'abc2342',
                channels: [
                    {
                        url: 'https://abc.com',
                        channel_id: 1,
                    },
                ],
            };

            const utilsPromptUserForChannelStub = jest
                .spyOn(utils, 'promptUserToSelectChannel')
                .mockReturnValue([]);

            promptUserForChannel(options);

            expect(utilsPromptUserForChannelStub).toHaveBeenCalled();
        });
    });

    describe('.promptUserForChannels', () => {
        let mockPromptUserToSelectChannel;
        beforeEach(() => {
            mockPromptUserToSelectChannel = jest
                .spyOn(utils, 'promptUserToSelectChannels')
                .mockReturnValue({});
        });

        it('should return options when applyTheme is true and channelIds available', async () => {
            const result = await promptUserForChannels(optionsApplyThemeIsTrueAndChannels);

            expect(mockPromptUserToSelectChannel).toHaveBeenCalledTimes(0);
            expect(result).toEqual(optionsApplyThemeIsTrueAndChannels);
        });

        it('should return options with all channelIds available when -allc option used', async () => {
            const options = {
                applyTheme: true,
                apiHost: 'abc2342',
                allChannels: true,
                channels: [
                    {
                        url: 'https://abc.com',
                        channel_id: 1,
                    },
                    {
                        url: 'https://fff.com',
                        channel_id: 2,
                    },
                ],
            };

            const result = await promptUserForChannels(options);

            expect(mockPromptUserToSelectChannel).toHaveBeenCalledTimes(0);
            expect(result).toEqual(optionsResult);
        });
    });
    describe('promptUserToSelectChannels', () => {
        it('should return an array with a single channel ID if a store only has a single channel', async () => {
            const channels = [
                {
                    id: 1000,
                    url: 'https://abc.com',
                    channel_id: 1,
                    created_at: '2021-06-17T00:20:30Z',
                    updated_at: '2021-06-17T00:20:36Z',
                },
            ];

            const expected = [1];

            const result = await promptUserToSelectChannels(channels);

            expect(result).toEqual(expect.arrayContaining(expected));
        });
    });
});
