import { describe, it, expect } from 'vitest';
import {
  normalizeInboundMessage,
  webhookToNormalizedMessages,
  senderPhoneFromKey,
} from './wasender-normalize';
import { parseWasenderWebhook } from './wasender-types';

describe('senderPhoneFromKey', () => {
  it('prefers cleanedParticipantPn for group messages', () => {
    const phone = senderPhoneFromKey({
      id: 'a',
      fromMe: false,
      remoteJid: '123456789-987654321@g.us',
      participant: '987654321@lid',
      participantPn: '987654321@s.whatsapp.net',
      cleanedParticipantPn: '987654321',
    });
    expect(phone).toBe('+987654321');
  });

  it('falls back to cleanedSenderPn for private chats', () => {
    const phone = senderPhoneFromKey({
      id: 'b',
      fromMe: false,
      remoteJid: '555555555@lid', // LID — never use this as a phone
      cleanedSenderPn: '5551234567',
      senderLid: '555555555@lid',
    });
    expect(phone).toBe('+5551234567');
  });

  it('returns empty string when nothing resolvable', () => {
    expect(
      senderPhoneFromKey({ id: 'c', fromMe: false, remoteJid: 'weird-jid' })
    ).toBe('');
  });
});

describe('normalizeInboundMessage', () => {
  it('normalizes a plain text message (LID remoteJid, cleaned phone)', () => {
    const n = normalizeInboundMessage({
      key: {
        id: '3EB0X123456789',
        fromMe: false,
        remoteJid: '555555555@lid',
        cleanedSenderPn: '5551234567',
      },
      messageBody: 'Hello, I have a question',
      message: { conversation: 'Hello, I have a question' },
    });

    expect(n.messageId).toBe('3EB0X123456789');
    expect(n.senderPhone).toBe('+5551234567');
    expect(n.text).toBe('Hello, I have a question');
    expect(n.contentType).toBe('text');
    expect(n.isGroup).toBe(false);
    expect(n.fromMe).toBe(false);
    expect(n.media).toBeUndefined();
  });

  it('extracts media + caption from an image message', () => {
    const n = normalizeInboundMessage({
      key: {
        id: 'img-1',
        fromMe: false,
        remoteJid: '15550199@s.whatsapp.net',
        cleanedSenderPn: '15550199',
      },
      messageBody: 'Check this photo',
      message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/encrypted.jpg',
          mediaKey: 'base64-key',
          mimetype: 'image/jpeg',
          fileLength: '1024',
        },
      },
    });

    expect(n.contentType).toBe('image');
    expect(n.text).toBe('Check this photo');
    expect(n.media).toMatchObject({
      kind: 'image',
      url: 'https://mmg.whatsapp.net/encrypted.jpg',
      mediaKey: 'base64-key',
    });
  });

  it('detects group messages via @g.us', () => {
    const n = normalizeInboundMessage({
      key: {
        id: 'g-1',
        fromMe: false,
        remoteJid: '123456789-987654321@g.us',
        participant: '123456789@lid',
        cleanedParticipantPn: '123456789',
      },
      messageBody: 'Hey everyone!',
      message: { conversation: 'Hey everyone!' },
    });

    expect(n.isGroup).toBe(true);
    expect(n.senderPhone).toBe('+123456789');
    expect(n.remoteJid).toBe('123456789-987654321@g.us');
  });

  it('extracts interactive reply ids (button taps)', () => {
    const n = normalizeInboundMessage({
      key: {
        id: 'i-1',
        fromMe: false,
        remoteJid: '15550199@s.whatsapp.net',
        cleanedSenderPn: '15550199',
      },
      messageBody: 'Existing customer',
      message: {
        interactiveMessage: {
          buttonReplyMessage: { id: 'btn_existing', title: 'Existing customer' },
        },
      },
    });

    expect(n.contentType).toBe('interactive');
    expect(n.interactiveReplyId).toBe('btn_existing');
    expect(n.text).toBe('Existing customer');
  });
});

describe('webhookToNormalizedMessages', () => {
  it('handles messages.received (single object)', () => {
    const w = parseWasenderWebhook({
      event: 'messages.received',
      timestamp: 1633456789,
      data: {
        messages: {
          key: {
            id: 'm-1',
            fromMe: false,
            remoteJid: '555555555@lid',
            cleanedSenderPn: '5551234567',
          },
          messageBody: 'Hello',
          message: { conversation: 'Hello' },
        },
      },
    });

    const list = webhookToNormalizedMessages(w!);
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('Hello');
  });

  it('handles messages.upsert (array) and filters outbound', () => {
    const w = parseWasenderWebhook({
      event: 'messages.upsert',
      timestamp: 1633456789,
      data: {
        messages: [
          {
            key: { id: 'in-1', fromMe: false, remoteJid: '1@s.whatsapp.net', cleanedSenderPn: '1' },
            messageBody: 'inbound',
            message: { conversation: 'inbound' },
          },
          {
            key: { id: 'out-1', fromMe: true, remoteJid: '1@s.whatsapp.net', cleanedSenderPn: '1' },
            messageBody: 'outbound echo',
            message: { conversation: 'outbound echo' },
          },
        ],
      },
    });

    const list = webhookToNormalizedMessages(w!);
    expect(list).toHaveLength(1);
    expect(list[0].messageId).toBe('in-1');
  });

  it('returns [] for non-message events (status updates)', () => {
    const w = parseWasenderWebhook({
      event: 'messages.update',
      sessionId: 'k',
      timestamp: 1,
      data: { update: { status: 2 }, key: { id: 'x', fromMe: true, remoteJid: '1@s.whatsapp.net' } },
    });
    expect(webhookToNormalizedMessages(w!)).toEqual([]);
  });
});
