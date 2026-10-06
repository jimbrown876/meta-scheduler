export function connectionLost(error) {
  const text = `${error?.code || ''} ${error?.message || ''} ${error?.cause?.code || ''}`;
  return /DESKTOP_OFFLINE|QUEUE_LEASE_CHANGED|Target page, context or browser has been closed|Target closed|net::ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_[A-Z_]+|TIMED_OUT|NAME_NOT_RESOLVED)|\b(?:ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ENOTFOUND)\b/.test(text);
}
