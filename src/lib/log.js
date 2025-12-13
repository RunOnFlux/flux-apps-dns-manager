const formatTimestamp = () => {
  const now = new Date();
  return now.toISOString();
};

const formatMessage = (level, message) => `[${formatTimestamp()}] [${level}] ${message}`;

const log = {
  info: (message) => {
    console.log(formatMessage('INFO', message));
  },
  warn: (message) => {
    console.warn(formatMessage('WARN', message));
  },
  error: (message) => {
    if (message instanceof Error) {
      console.error(formatMessage('ERROR', `${message.message}\n${message.stack}`));
    } else {
      console.error(formatMessage('ERROR', message));
    }
  },
  debug: (message) => {
    if (process.env.DEBUG) {
      console.log(formatMessage('DEBUG', message));
    }
  },
};

module.exports = log;
