import { type ExtendedUIMessage } from 'twenty-shared/ai';

import { injectAttachedFileIds } from 'src/engine/metadata-modules/ai/ai-chat/utils/inject-attached-file-ids.util';
import { replaceUnsupportedFileParts } from 'src/engine/metadata-modules/ai/ai-chat/utils/replace-unsupported-file-parts.util';

const buildFilePart = (
  mediaType: string,
  fileId: string,
  filename?: string,
  storagePath?: string,
) => ({
  type: 'file' as const,
  mediaType,
  filename,
  url: 'https://crm.example.de/file/agent-chat/abc?token=x',
  fileId,
  storagePath,
});

const buildTextPart = (text: string) => ({ type: 'text' as const, text });

const buildMessage = (
  role: ExtendedUIMessage['role'],
  parts: ExtendedUIMessage['parts'],
): ExtendedUIMessage => ({ id: 'message-id', role, parts });

const lastText = (message: ExtendedUIMessage): string => {
  const part = message.parts[message.parts.length - 1];

  return part.type === 'text' ? part.text : '';
};

describe('injectAttachedFileIds', () => {
  it('appends the id of an attached image', () => {
    const messages = [
      buildMessage('user', [
        buildTextPart('post this'),
        buildFilePart('image/jpeg', 'file-1', 'holiday.jpg'),
      ]),
    ];

    const result = injectAttachedFileIds(messages);

    expect(lastText(result[0])).toContain('`holiday.jpg` (image/jpeg)');
    expect(lastText(result[0])).toContain('`file-1`');
  });

  it.each([
    ['video/mp4', 'reel.mp4'],
    ['application/pdf', 'brief.pdf'],
    ['audio/mpeg', 'voice.mp3'],
  ])('appends the id for %s', (mediaType, filename) => {
    const messages = [
      buildMessage('user', [buildFilePart(mediaType, 'file-9', filename)]),
    ];

    const result = injectAttachedFileIds(messages);

    expect(lastText(result[0])).toContain(`\`${filename}\` (${mediaType})`);
    expect(lastText(result[0])).toContain('`file-9`');
  });

  it('lists every attached file', () => {
    const messages = [
      buildMessage('user', [
        buildFilePart('image/png', 'file-1', 'a.png'),
        buildFilePart('video/mp4', 'file-2', 'b.mp4'),
      ]),
    ];

    const text = lastText(injectAttachedFileIds(messages)[0]);

    expect(text).toContain('`file-1`');
    expect(text).toContain('`file-2`');
  });

  // The reference is a footnote to what the user wrote. Leading with it reads
  // as though the user asked about the files.
  it('appends rather than prepends, leaving the original parts in place', () => {
    const messages = [
      buildMessage('user', [
        buildTextPart('post this'),
        buildFilePart('image/png', 'file-1', 'a.png'),
      ]),
    ];

    const result = injectAttachedFileIds(messages);

    expect(result[0].parts).toHaveLength(3);
    expect(result[0].parts[0]).toEqual(buildTextPart('post this'));
  });

  it('leaves a message with no attachments untouched', () => {
    const messages = [buildMessage('user', [buildTextPart('hello')])];

    expect(injectAttachedFileIds(messages)).toEqual(messages);
  });

  it('leaves assistant messages untouched', () => {
    const messages = [
      buildMessage('assistant', [
        buildFilePart('image/png', 'file-1', 'a.png'),
      ]),
    ];

    expect(injectAttachedFileIds(messages)).toEqual(messages);
  });

  it('falls back to a label when the file has no filename', () => {
    const messages = [
      buildMessage('user', [buildFilePart('image/png', 'file-1')]),
    ];

    expect(lastText(injectAttachedFileIds(messages)[0])).toContain(
      '`attachment` (image/png)',
    );
  });
});

// Guards the order these two run in inside chat-execution.service.
// replaceUnsupportedFileParts turns a file the model cannot read into a text
// stub and drops the fileId with it, so injecting afterwards loses exactly the
// files the agent most needs a handle for.
describe('injectAttachedFileIds ordering against replaceUnsupportedFileParts', () => {
  const textOf = (message: ExtendedUIMessage): string =>
    message.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');

  it('keeps the id of a file the model cannot read', () => {
    const messages = [
      buildMessage('user', [
        buildFilePart('video/quicktime', 'file-1', 'clip.mov'),
      ]),
    ];

    const stubbed = replaceUnsupportedFileParts(
      injectAttachedFileIds(messages),
      ['image'],
      false,
    );

    expect(textOf(stubbed[0])).toContain('`file-1`');
    expect(textOf(stubbed[0])).toContain('not supported for direct analysis');
  });

  it('loses the id when run the other way round', () => {
    const messages = [
      buildMessage('user', [
        buildFilePart('video/quicktime', 'file-1', 'clip.mov'),
      ]),
    ];

    const wrongOrder = injectAttachedFileIds(
      replaceUnsupportedFileParts(messages, ['image'], false),
    );

    expect(textOf(wrongOrder[0])).not.toContain('`file-1`');
  });
});

describe('injectAttachedFileIds storage path', () => {
  const PATH =
    'dacaae54-d2ce-4f8b-aa04-c973107c6449/f37e0d33-4582-40b0-afee-09c133fe1515/agent-chat/72fe5175-ca7d-4f65-8f63-d05257ffff1b.png';

  it('gives the storage path verbatim so nothing has to be assembled', () => {
    const messages = [
      buildMessage('user', [
        buildFilePart('image/png', 'file-1', 'shot.png', PATH),
      ]),
    ];

    expect(lastText(injectAttachedFileIds(messages)[0])).toContain(
      `storage path: \`${PATH}\``,
    );
  });

  it('still lists the file when no storage path is known', () => {
    const messages = [
      buildMessage('user', [buildFilePart('image/png', 'file-1', 'shot.png')]),
    ];

    const text = lastText(injectAttachedFileIds(messages)[0]);

    expect(text).toContain('`file-1`');
    expect(text).not.toContain('storage path');
  });

  // The model previously copied the shape of an example URL and filled in an
  // id it happened to have, producing /file/attachment/<attachmentId>.
  it('tells the model not to construct paths itself', () => {
    const messages = [
      buildMessage('user', [
        buildFilePart('image/png', 'file-1', 'shot.png', PATH),
      ]),
    ];

    expect(lastText(injectAttachedFileIds(messages)[0])).toContain(
      'Never\nconstruct a file URL or a path yourself',
    );
  });
});
