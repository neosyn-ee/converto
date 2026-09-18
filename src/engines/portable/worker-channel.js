// Canale verso il processo principale: utilityProcess di Electron, oppure child_process.fork
// (con serialization: 'advanced') quando i processi vengono provati in Node.
function connect(onMessage) {
  if (process.parentPort) {
    process.parentPort.on('message', (event) => onMessage(event.data));
    return (message) => process.parentPort.postMessage(message);
  }
  process.on('message', onMessage);
  return (message) => process.send(message);
}

module.exports = { connect };
