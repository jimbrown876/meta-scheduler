// One factual listing standard; channel-specific navigation stays explicit.
export const listingCopyVersion = 2;

export function legacyFacebookCaption(item, config) {
  const prefix = item.status === 'sold' ? 'SOLD — ' : item.status === 'reserved' ? 'RESERVED — ' : '';
  return `${prefix}${item.title.trim()}${item.price ? ` — ${item.price}` : ''}\n\n${item.description.trim()}\n\nSee photos and ask about this machine:\n${item.url}#inquire${item.status === 'sold' ? `\n\nBrowse available machines: ${config.availableUrl}` : '\n\nAvailability is confirmed when we reply.'}`;
}

export function listingCaption(item, config, channel = 'facebook') {
  if (!['facebook', 'instagram'].includes(channel)) throw new Error('Unsupported listing channel.');
  const prefix = item.status === 'sold' ? 'SOLD — ' : item.status === 'reserved' ? 'RESERVED — ' : '';
  const heading = `${prefix}${item.title.trim()}${item.price ? ` — ${item.price}` : ''}`;
  const location = item.location?.trim() ? `Location: ${item.location.trim()}` : '';
  const follow = `Follow ${config.pageName || 'Georgia Wood Tools'} for new arrivals and machine demonstrations.`;
  const navigation = channel === 'instagram'
    ? `Photos, details and inquiries: open the website link in our bio, choose “${item.title.trim()}”, then use its inquiry form.\nMachine page: ${item.url}#inquire`
    : `See photos, details and ask about this machine:\n${item.url}#inquire`;
  const availability = item.status === 'sold'
    ? `This machine is sold. ${channel === 'instagram' ? 'Browse current stock using the website link in our bio.\nCurrent stock:' : 'Browse current stock:'} ${config.availableUrl}\nMachine archive: ${item.url}#inquire`
    : `${navigation}\n\n${item.status === 'reserved' ? 'This machine is reserved. Ask us about its current availability.' : 'Availability is confirmed when we reply.'} Confirm viewing and pickup arrangements before travelling.`;
  const start = [heading, location].filter(Boolean).join('\n');
  const end = `${availability}\n\n${follow}`;
  const max = channel === 'instagram' ? 2200 : 6000;
  const room = max - start.length - end.length - 4;
  if (room < 0) throw new Error('Listing essentials exceed the channel caption limit.');
  let description = item.description.trim();
  if (description.length > room) {
    description = description.slice(0, Math.max(0, room - 1)).replace(/[\uD800-\uDBFF]$/, '').trimEnd() + (room ? '…' : '');
  }
  return [start, description, end].filter(Boolean).join('\n\n');
}
