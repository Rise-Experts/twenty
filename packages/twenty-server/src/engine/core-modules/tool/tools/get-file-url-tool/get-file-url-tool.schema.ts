import { z } from 'zod';

export const GetFileUrlInputZodSchema = z.object({
  fileId: z
    .string()
    .describe(
      'The id of a file attached to the conversation, taken from a ' +
        '`[filename](fileid:<id>)` reference in the message. A UUID. ' +
        'Copy it exactly; never invent one.',
    ),
});

export type GetFileUrlInput = z.infer<typeof GetFileUrlInputZodSchema>;
