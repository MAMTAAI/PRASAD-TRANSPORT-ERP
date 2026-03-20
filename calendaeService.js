import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

// ES Module में फोल्डर का रास्ता निकालने का तरीका
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// चाबी वाली फाइल का रास्ता (ध्यान रहे google-key.json इसी फोल्डर में हो)
const KEYFILEPATH = path.join(__dirname, 'google-key.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILEPATH,
  scopes: SCOPES,
});

const calendar = google.calendar({ version: 'v3', auth });

// आपकी नई वाली पक्की Calendar ID
const CALENDAR_ID = '3376f3a7d26786edf879a1d077126aeb4a3b606aa7ba80ac9c288f1f62374c2d@group.calendar.google.com';

// यह फंक्शन आपके ERP से डाटा लेगा और कैलेंडर में ईवेंट बनाएगा
export const addEventToCalendar = async (eventName, eventDate, description) => {
  try {
    // तारीख को सही फॉर्मेट में सेट करना
    const startDate = new Date(eventDate);
    // रिमाइंडर का समय: सुबह 9:00 बजे सेट कर रहे हैं
    startDate.setHours(9, 0, 0); 

    const endDate = new Date(startDate);
    endDate.setHours(10, 0, 0); // 10 बजे तक का स्लॉट

    const event = {
      summary: eventName,
      description: description,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: 'Asia/Kolkata',
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: 'Asia/Kolkata',
      },
    };

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
    });

    console.log(`✅ रोबोट ने कैलेंडर में सेव किया: ${eventName}`);
    return response.data;
  } catch (error) {
    console.error('❌ रोबोट को कैलेंडर में एंट्री करने में दिक्कत हुई:', error);
  }
};