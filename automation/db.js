'use strict';

const useRemote = !!(process.env.REMOTE_DB_URL || '').trim();
const impl = useRemote ? require('./db-remote') : require('./db-local');

module.exports = {
  ...impl,
  useRemote,
  liveUrl: useRemote ? (process.env.REMOTE_DB_URL || '').replace(/\/$/, '') : null,
};
