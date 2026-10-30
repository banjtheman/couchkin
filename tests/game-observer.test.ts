import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GameObservationError,
  observeGame,
  type ObserveGameOptions,
} from '../src/main/game-observer';
import { defaultCharacter } from '../src/shared/defaults';
import { personalityIds, personalityInstructions } from '../src/shared/personalities';

const fetchMock = vi.fn<typeof fetch>();
const options: ObserveGameOptions = {
  apiKey: 'local-test-key-never-sent',
  image: 'data:image/jpeg;base64,/9j/2Q==',
  game: 'An adventure game',
  character: defaultCharacter,
  previousSummary: 'The player is beside a merchant in a stone room.',
  recentRemarks: ['Those crystals are doing all the interior decorating.'],
};

function completed(result: unknown, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(result) }],
        },
      ],
      ...extra,
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('passive game observations', () => {
  it.each(personalityIds)(
    'sends %s behavior only as reaction direction while retaining factual silence',
    async (personality) => {
      const character = { ...defaultCharacter, personality };
      fetchMock.mockResolvedValue(completed({ summary: 'The player has 32 HP.', reaction: '' }));
      const result = await observeGame({ ...options, character });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.instructions).toContain(
        `Trusted application personality instructions for reaction only:\n${personalityInstructions(character)}`,
      );
      expect(body.instructions).toContain('Keep summary neutral and factual.');
      expect(body.instructions).toContain(
        'personality never requires a joke, praise, advice, or speech on each frame',
      );
      expect(body.tools).toBeUndefined();
      expect(result.summary).toBe('The player has 32 HP.');
      expect(result.reaction).toBe('');
    },
  );

  it('keeps an unchanged frame silent and sends bounded context with strict output and no tools', async () => {
    fetchMock.mockResolvedValue(completed({ summary: options.previousSummary, reaction: '' }));
    const result = await observeGame(options);
    expect(result).toEqual({ summary: options.previousSummary, reaction: '', usageTokens: 0 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${options.apiKey}` });
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      store: false,
      reasoning: { effort: 'none' },
      max_output_tokens: 700,
      text: {
        format: {
          type: 'json_schema',
          strict: true,
          schema: { required: ['summary', 'reaction'], additionalProperties: false },
        },
      },
    });
    expect(body.tools).toBeUndefined();
    const context = JSON.parse(body.input[0].content[0].text);
    expect(context).toMatchObject({
      game: options.game,
      previousSummary: options.previousSummary,
      recentRemarks: options.recentRemarks,
      character: { personality: defaultCharacter.personality, noSpoilers: true },
    });
    expect(body.input[0].content[1]).toEqual({
      type: 'input_image',
      image_url: options.image,
      detail: 'auto',
    });
    expect(init?.body).not.toContain(options.apiKey);
  });

  it('returns a meaningful reaction and validated usage independently from the factual summary', async () => {
    fetchMock.mockResolvedValue(
      completed(
        {
          summary: ' A victory banner is now visible. ',
          reaction: ' That last hit earned its paycheck. ',
        },
        { usage: { total_tokens: 175 } },
      ),
    );
    await expect(observeGame(options)).resolves.toEqual({
      summary: 'A victory banner is now visible.',
      reaction: 'That last hit earned its paycheck.',
      usageTokens: 175,
    });
  });

  it.each([
    { summary: 'Room', reaction: 'x'.repeat(221) },
    { summary: 'x'.repeat(901), reaction: '' },
    { summary: 'Room', reaction: '', extra: 'private content' },
    { summary: 'Room', reaction: null },
    { reaction: '' },
  ])('rejects an invalid structured result without exposing its content', async (result) => {
    fetchMock.mockResolvedValue(completed(result));
    await expect(observeGame(options)).rejects.toThrow(
      'OpenAI returned an incomplete or invalid game observation.',
    );
  });

  it.each([
    '{private malformed response',
    JSON.stringify({ status: 'incomplete', output: [], error: options.apiKey }),
    JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: options.apiKey }] }],
    }),
  ])('sanitizes malformed, incomplete and refused API responses', async (body) => {
    fetchMock.mockResolvedValue(new Response(body));
    await expect(observeGame(options)).rejects.toThrow(
      'OpenAI returned an incomplete or invalid game observation.',
    );
  });

  it.each([401, 403, 429, 500])('does not expose an HTTP %s body', async (status) => {
    fetchMock.mockResolvedValue(new Response(`private prompt ${options.apiKey}`, { status }));
    const error = await observeGame(options).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'observation_http_error', httpStatus: status });
    expect(String(error)).not.toContain(options.apiKey);
    expect(String(error)).not.toContain('private prompt');
  });

  it('sanitizes transport errors', async () => {
    fetchMock.mockRejectedValue(new Error(`private prompt ${options.apiKey}`));
    await expect(observeGame(options)).rejects.toThrow(
      'Could not reach OpenAI for a game observation.',
    );
  });

  it('keeps an allowlisted nested network cause without retaining raw diagnostics', async () => {
    fetchMock.mockRejectedValue(
      new Error(`private ${options.apiKey}`, {
        cause: { code: 'ECONNRESET', url: options.image, message: options.apiKey },
      }),
    );
    const error = await observeGame(options).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GameObservationError);
    expect(error).toMatchObject({ code: 'observation_network_error', transportCode: 'ECONNRESET' });
    expect(JSON.stringify(error)).not.toContain(options.apiKey);
    expect(JSON.stringify(error)).not.toContain(options.image);
    expect((error as Error).cause).toBeUndefined();
  });

  it('drops arbitrary transport codes instead of persisting them', async () => {
    fetchMock.mockRejectedValue({ code: options.apiKey, cause: { code: options.image } });
    const error = await observeGame(options).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'observation_network_error' });
    expect((error as GameObservationError).transportCode).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(options.apiKey);
  });

  it('distinguishes response body failures from network startup and malformed JSON', async () => {
    const response = new Response();
    vi.spyOn(response, 'text').mockRejectedValue({
      code: 'UND_ERR_SOCKET',
      message: options.apiKey,
    });
    fetchMock.mockResolvedValue(response);
    await expect(observeGame(options)).rejects.toMatchObject({
      code: 'observation_body_error',
      transportCode: 'UND_ERR_SOCKET',
    });
    fetchMock.mockResolvedValue(new Response(options.apiKey));
    await expect(observeGame(options)).rejects.toMatchObject({
      code: 'observation_invalid_response',
    });
  });

  it.each([
    'https://example.com/image.jpg',
    'file:///private/image.png',
    'data:image/svg+xml;base64,AAAA',
    'data:image/png;base64,/9j/2Q==',
    'data:image/jpeg;base64,!!!!',
    'data:image/jpeg;base64,/9j/2R==',
    `data:image/jpeg;base64,${Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(3 * 1024 * 1024)]).toString('base64')}`,
  ])('rejects an invalid or oversized image before any network request', async (image) => {
    await expect(observeGame({ ...options, image })).rejects.toThrow('Game screenshot');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds previous context and the number and size of recent remarks', async () => {
    fetchMock.mockResolvedValue(completed({ summary: 'Room', reaction: '' }));
    await observeGame({
      ...options,
      previousSummary: 'x'.repeat(5000),
      recentRemarks: Array.from({ length: 20 }, (_, i) => `${i}: ${'x'.repeat(1000)}`),
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    const context = JSON.parse(body.input[0].content[0].text);
    expect(context.previousSummary).toHaveLength(900);
    expect(context.recentRemarks).toHaveLength(8);
    expect(context.recentRemarks[0]).toMatch(/^12:/);
    expect(context.recentRemarks.every((remark: string) => remark.length <= 220)).toBe(true);
  });

  it('never sends when the caller has already canceled', async () => {
    const controller = new AbortController();
    controller.abort(new Error(options.apiKey));
    await expect(observeGame({ ...options, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Game observation canceled.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels a pending request immediately without leaking the abort reason', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const result = observeGame({ ...options, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Game observation canceled.',
    });
    controller.abort(new Error(options.apiKey));
    await rejected;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('bounds the whole request even when reading the response body stalls', async () => {
    vi.useFakeTimers();
    const response = new Response();
    vi.spyOn(response, 'text').mockImplementation(() => new Promise(() => {}));
    fetchMock.mockResolvedValue(response);
    const result = observeGame(options);
    const rejected = expect(result).rejects.toMatchObject({ code: 'observation_timeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
