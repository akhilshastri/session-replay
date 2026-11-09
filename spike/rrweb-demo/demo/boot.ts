/** Starts the recorder before the app code runs. Stands in for the host shell injecting the recorder-service. */
import '../recorder';

const user = new URLSearchParams(location.search).get('user') || 'alice';
window.SessionRecorder.start({ userId: user, endpoint: location.origin });
