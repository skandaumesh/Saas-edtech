// ============================================================================
// CHATBOT ROUTES - COMPLETE FIXED VERSION WITH ICONS
// ============================================================================

const express = require('express');
const router = express.Router();
const queryGenerator = require('../services/queryGenerator');
const geminiService = require('../services/geminiService');


// ============================================================================
// ATTENDANCE REPORT FORMATTER
// ============================================================================

function formatAttendanceReport(data) {
  if (!data || data.length === 0) {
    return "No attendance data found for this student.";
  }

  const student = data[0];
  let response = `# Attendance Report for ${student.studentName}\n\n`;
  response += `Student ID: ${student.studentID}\n`;
  response += `Stream: ${student.stream} | Semester: ${student.semester}\n\n`;

  // Calculate overall stats
  const totalClassesAll = data.reduce((sum, s) => sum + (s.totalClasses || 0), 0);
  const totalAttendedAll = data.reduce((sum, s) => sum + (s.classesAttended || 0), 0);
  const overallPercentage = totalClassesAll > 0
    ? ((totalAttendedAll / totalClassesAll) * 100).toFixed(2)
    : 0;

  response += `## Overall Summary\n\n`;
  response += `- Total Classes: ${totalClassesAll}\n`;
  response += `- Classes Attended: ${totalAttendedAll}\n`;
  response += `- Classes Absent: ${totalClassesAll - totalAttendedAll}\n`;
  response += `- Overall Percentage: ${overallPercentage}%\n\n`;

  response += `## Subject-wise Breakdown\n\n`;
  response += `| Subject | Attended | Total | Absent | Percentage |\n`;
  response += `|---------|----------|-------|--------|------------|\n`;

  data.forEach(subject => {
    const pctVal = subject.attendancePercentage || 0;
    const percentage = typeof pctVal === 'number' ? pctVal.toFixed(2) : '0.00';
    const status = pctVal >= 75 ? 'OK' : 'LOW';
    response += `| ${subject.subject || 'Unknown'} | ${subject.classesAttended || 0} | ${subject.totalClasses || 0} | ${subject.classesAbsent || 0} | ${percentage}% (${status}) |\n`;
  });

  // Add shortage warning
  const shortageSubjects = data.filter(s => (s.attendancePercentage || 0) < 75);
  if (shortageSubjects.length > 0) {
    response += `\n## Attendance Shortage Alert\n\n`;
    response += `The following subjects are below 75% attendance:\n\n`;
    shortageSubjects.forEach(s => {
      const classesNeeded = Math.max(0, Math.ceil((75 * (s.totalClasses || 0) - 100 * (s.classesAttended || 0)) / 25));
      const pctVal = s.attendancePercentage || 0;
      const pctStr = typeof pctVal === 'number' ? pctVal.toFixed(2) : '0.00';
      response += `- **${s.subject || 'Unknown'}:** ${pctStr}% (Need ${classesNeeded} more ${classesNeeded === 1 ? 'class' : 'classes'})\n`;
    });
  } else if (totalClassesAll > 0) {
    response += `\n## Excellent!\n\nAll subjects have adequate attendance (≥75%).\n`;
  }

  return response;
}


// ============================================================================
// CHAT ENDPOINT
// ============================================================================

router.post('/chat', async (req, res) => {
  try {
    // Accept both 'message' and 'question', plus conversation history
    const { message, question, history } = req.body;
    const userQuery = message || question;
    const conversationHistory = Array.isArray(history) ? history : [];

    if (!userQuery || !userQuery.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }

    console.log('User Query:', userQuery);
    console.log('Conversation History Length:', conversationHistory.length);

    // ================================================================
    // FOLLOW-UP DETECTION: Resolve context from conversation history
    // ================================================================
    let resolvedQuery = userQuery;
    const lowerQuery = userQuery.toLowerCase().trim();

    // Detect follow-up patterns
    const followUpPatterns = [
      /^(?:what about|how about|and for|and|also|same for|check for|show for|now for|now check|tell me about)\s+(.+)/i,
      /^(?:what's|whats|what is)\s+(.+?)(?:'s|s)?\s*(?:attendance|report|details|info)?\s*$/i,
      /^(.+?)(?:'s|s)?\s+(?:attendance|report|details|info)\s*\??$/i
    ];

    if (conversationHistory.length > 0) {
      for (const pattern of followUpPatterns) {
        const match = lowerQuery.match(pattern);
        if (match && match[1]) {
          const newSubject = match[1].trim();
          // Find the last user query to understand context
          const lastUserMessages = conversationHistory.filter(m => m.role === 'user');
          if (lastUserMessages.length > 0) {
            const lastQuestion = lastUserMessages[lastUserMessages.length - 1].content.toLowerCase();

            // If previous question was about attendance
            if (lastQuestion.includes('attendance') || lastQuestion.includes('report')) {
              resolvedQuery = `Show attendance report for ${newSubject}`;
              console.log(`Follow-up detected! Resolved: "${userQuery}" -> "${resolvedQuery}"`);
            }
            // If previous question was about student details
            else if (lastQuestion.includes('student') || lastQuestion.includes('find') || lastQuestion.includes('show') || lastQuestion.includes('details')) {
              resolvedQuery = `Show details for ${newSubject}`;
              console.log(`Follow-up detected! Resolved: "${userQuery}" -> "${resolvedQuery}"`);
            }
            // If previous question was about subjects
            else if (lastQuestion.includes('subject') || lastQuestion.includes('course')) {
              resolvedQuery = `Show subjects for ${newSubject}`;
              console.log(`Follow-up detected! Resolved: "${userQuery}" -> "${resolvedQuery}"`);
            }
            // Generic follow-up - just search for the entity
            else {
              resolvedQuery = `Show details for ${newSubject}`;
              console.log(`Generic follow-up detected! Resolved: "${userQuery}" -> "${resolvedQuery}"`);
            }
          }
          break;
        }
      }
    }

    // Handle simple greetings without API call
    const greetings = ['hi', 'hello', 'hey', 'hii', 'hiii', 'good morning', 'good afternoon', 'good evening'];
    if (greetings.includes(lowerQuery) || greetings.some(g => lowerQuery === g + '!' || lowerQuery === g + '.')) {
      return res.json({
        success: true,
        answer: "Hi there! I'm your college AI assistant. I can help you with student and teacher information, attendance, subjects, and various college statistics. How can I assist you today?",
        queryInfo: { collection: null, operation: null, explanation: 'Greeting response' }
      });
    }

    // Step 1: Generate MongoDB query (use resolved query for follow-ups)
    const queryInfo = await queryGenerator.generateMongoQuery(resolvedQuery);
    console.log('Generated Query:', JSON.stringify(queryInfo, null, 2));

    // Check if this is a greeting or non-database query
    if (!queryInfo.collection || queryInfo.collection === null || queryInfo.operation === null) {
      console.log('Non-database query detected');

      // Use conversation history for context-aware responses
      const conversationalResponse = await geminiService.generateResponseWithHistory(`
You are a friendly college AI assistant. The user said: "${userQuery}"

Respond warmly and naturally. If it's a greeting, greet them and briefly mention what you can help with.

You can help with:
- Finding students by name, ID, stream, or semester
- Viewing subjects for different streams and semesters  
- Generating detailed attendance reports for students
- Checking attendance records for specific dates
- Getting statistics about students, teachers, and subjects
- Viewing teacher information and their subjects

Keep your response brief, friendly, and helpful (2-3 sentences max).
DO NOT use emojis - use simple text only.
      `, conversationHistory);

      return res.json({
        success: true,
        answer: conversationalResponse.trim(),
        queryInfo: {
          collection: null,
          operation: null,
          explanation: queryInfo.explanation || 'Conversational response'
        },
        resultCount: 0
      });
    }

    // Step 2: Execute the database query
    let queryResults;
    try {
      queryResults = await queryGenerator.executeQuery(queryInfo);
      console.log('Query Results:', Array.isArray(queryResults) ? `${queryResults.length} records` : queryResults);
    } catch (executeError) {
      console.error('Query execution failed:', executeError);

      const errorMsg = executeError.message;

      // No attendance records exist for stream/semester
      if (errorMsg.startsWith('NO_ATTENDANCE_RECORDS:')) {
        const [, studentName, stream, semester] = errorMsg.split(':');
        return res.json({
          success: true,
          answer: `## Student Found: ${studentName}\n\nStream: ${stream} | Semester: ${semester}\n\n## No Classes Conducted Yet\n\nThere are no attendance records for ${stream} semester ${semester}. This means:\n\n- No classes have been conducted for this stream/semester\n- Attendance marking hasn't started yet\n- The semester may not have begun\n\n### What you can do:\n\n- Check other semesters\n- View subjects for this stream\n- See all students in this stream\n- View recent classes`,
          queryInfo: {
            collection: queryInfo.collection,
            operation: queryInfo.operation,
            explanation: 'No attendance records for stream/semester'
          },
          resultCount: 0
        });
      }

      // Student exists but has no attendance
      if (errorMsg.startsWith('STUDENT_EXISTS_NO_ATTENDANCE:')) {
        const [, studentName, stream, semester, studentID] = errorMsg.split(':');
        return res.json({
          success: true,
          answer: `## Student Found: ${studentName}\n\nStudent ID: ${studentID}\nStream: ${stream} | Semester: ${semester}\n\n## No Attendance Records\n\nThis student is registered in the system but hasn't attended any classes yet, or attendance wasn't marked when they were present.\n\n### Possible Reasons:\n\n- The student hasn't attended any classes\n- Attendance wasn't marked when student was present\n- The student is newly enrolled\n- Classes haven't started yet\n\n### Suggestions:\n\n- Check all ${stream} students\n- View subjects for this stream\n- Check recent classes\n- Try another student name`,
          queryInfo: {
            collection: queryInfo.collection,
            operation: queryInfo.operation,
            explanation: 'Student found but no attendance records'
          },
          resultCount: 0
        });
      }

      // Student not found
      if (errorMsg.startsWith('STUDENT_NOT_FOUND:')) {
        const studentName = errorMsg.split(':')[1];
        return res.json({
          success: true,
          answer: `## Student Not Found: "${studentName}"\n\nI couldn't find a student with that name in the database.\n\n## Suggestions:\n\n### Check the spelling of the name\n- Make sure the name is spelled correctly\n- Try using just the first name or last name\n\n### Try using the student ID\n- Student IDs follow a specific pattern\n- Example: Search by ID if you know it\n\n### Search by stream\n- Show BBA students\n- List BCA semester 5 students\n\n### List all students\n- List all students\n- Show students in a specific stream\n\n## Example Queries:\n\n- Show students in BBA semester 5\n- List all students\n- Find student with ID U18ER23C0015`,
          queryInfo: {
            collection: queryInfo.collection,
            operation: queryInfo.operation,
            explanation: 'Student not found in database'
          },
          resultCount: 0
        });
      }

      // Generic execution error
      return res.json({
        success: true,
        answer: `## Database Query Error\n\nI encountered an error while searching the database.\n\nError Details:\n${executeError.message}\n\n## What to try:\n\n- Rephrase your question\n- Check your search criteria\n- Use more specific terms\n- Try a simpler query first\n\n## Examples:\n\n- List all students\n- Show BBA subjects\n- Today's attendance`,
        queryInfo: {
          collection: queryInfo.collection,
          operation: queryInfo.operation,
          explanation: 'Query execution failed'
        },
        resultCount: 0
      });
    }

    // Handle empty results
    if (!queryResults ||
      (Array.isArray(queryResults) && queryResults.length === 0)) {

      let noResultsMessage = `## No Results Found\n\nI couldn't find any records matching your search.\n\n`;

      if (queryInfo.collection === 'students') {
        noResultsMessage += `## Suggestions for Student Search:\n\n`;
        noResultsMessage += `- Check the spelling of the student name\n`;
        noResultsMessage += `- Try using the student ID\n`;
        noResultsMessage += `- Search by stream: Show BCA students\n`;
        noResultsMessage += `- Search by semester: List BBA semester 5 students\n`;
        noResultsMessage += `- View all: List all students\n`;
      } else if (queryInfo.collection === 'subjects') {
        noResultsMessage += `## Suggestions for Subject Search:\n\n`;
        noResultsMessage += `- Verify the stream name (BCA, BBA, BCOM)\n`;
        noResultsMessage += `- Check the semester number (1-6)\n`;
        noResultsMessage += `- Try: Show BBA semester 5 subjects\n`;
        noResultsMessage += `- View all: List all subjects\n`;
      } else if (queryInfo.collection === 'attendance') {
        // Try to fetch recent dates with attendance data to help user
        try {
          const { getDB } = require('../config/database');
          const db = getDB();
          const recentDates = await db.collection('attendance').aggregate([
            { $group: { _id: "$date" } },
            { $sort: { _id: -1 } },
            { $limit: 5 }
          ]).toArray();

          if (recentDates.length > 0) {
            const dateList = recentDates.map(d => {
              const dateStr = d._id ? new Date(d._id).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : d._id;
              return `- ${dateStr}`;
            }).join('\n');

            noResultsMessage += `## No Attendance Records Found for This Date\n\n`;
            noResultsMessage += `The date you searched doesn't have any attendance records.\n\n`;
            noResultsMessage += `## Dates with Available Records:\n\n${dateList}\n\n`;
            noResultsMessage += `## Try These Queries:\n\n`;
            noResultsMessage += `- Show recent classes\n`;
            noResultsMessage += `- Today's attendance\n`;
            noResultsMessage += `- [Student name]'s attendance report\n`;
          } else {
            noResultsMessage += `## No Attendance Records in Database\n\n`;
            noResultsMessage += `There are no attendance records in the system yet.\n\n`;
            noResultsMessage += `## This Could Mean:\n\n`;
            noResultsMessage += `- Classes haven't been conducted yet\n`;
            noResultsMessage += `- Attendance hasn't been marked\n`;
            noResultsMessage += `- The academic session hasn't started\n`;
          }
        } catch (e) {
          noResultsMessage += `## Suggestions for Attendance Search:\n\n`;
          noResultsMessage += `- Verify the date format (YYYY-MM-DD)\n`;
          noResultsMessage += `- Check if attendance was recorded\n`;
          noResultsMessage += `- Try: Show recent classes\n`;
          noResultsMessage += `- For student report: Show [student name] attendance\n`;
        }
      } else {
        noResultsMessage += `## General Suggestions:\n\n`;
        noResultsMessage += `- Try rephrasing your question\n`;
        noResultsMessage += `- Check your search criteria\n`;
        noResultsMessage += `- Use simpler terms\n`;
        noResultsMessage += `- Try: List all students or Show all subjects\n`;
      }

      return res.json({
        success: true,
        answer: noResultsMessage,
        queryInfo: {
          collection: queryInfo.collection,
          operation: queryInfo.operation,
          explanation: 'No results found'
        },
        resultCount: 0
      });
    }

    // Check if this is an INDIVIDUAL student attendance report query
    const isIndividualReport = queryInfo.explanation &&
      (queryInfo.explanation.toLowerCase().includes('attendance report for') ||
        queryInfo.explanation.toLowerCase().includes('detailed report for') ||
        (queryInfo.explanation.toLowerCase().includes('attendance report') && queryResults.length > 0 && queryResults[0].studentName));

    // Step 3: Generate natural language response
    let naturalResponse;

    if (isIndividualReport && Array.isArray(queryResults) && queryResults.length > 0) {
      console.log('Formatting student attendance report...');
      naturalResponse = formatAttendanceReport(queryResults);
    }

    // If not an individual report or if formatting failed
    if (!naturalResponse) {
      if (Array.isArray(queryResults) && queryResults.length > 3) {
        // Use table format for lists with more than 3 items
        console.log('Formatting as table...');
        const tableFormat = queryGenerator.formatAsTable(queryResults, queryInfo.collection);

        if (tableFormat) {
          naturalResponse = `## Results (${queryResults.length} found)\n\n${tableFormat}\n\n**Total Records:** ${queryResults.length}`;
        } else {
          try {
            naturalResponse = await queryGenerator.generateNaturalResponse(userQuery, queryResults, queryInfo);
          } catch (geminiError) {
            naturalResponse = queryGenerator.friendlyFormatResults(queryResults, userQuery, queryInfo.collection);
          }
        }
      } else {
        try {
          naturalResponse = await queryGenerator.generateNaturalResponse(userQuery, queryResults, queryInfo);
        } catch (geminiError) {
          naturalResponse = queryGenerator.friendlyFormatResults(queryResults, userQuery, queryInfo.collection);
        }
      }
    }

    // Calculate result count
    let resultCount;
    if (Array.isArray(queryResults)) {
      resultCount = queryResults.length;
    } else if (typeof queryResults === 'number') {
      resultCount = queryResults;
    } else {
      resultCount = 1;
    }

    res.json({
      success: true,
      answer: naturalResponse.trim(),
      queryInfo: {
        collection: queryInfo.collection,
        operation: queryInfo.operation,
        explanation: queryInfo.explanation || 'Query executed successfully'
      },
      resultCount: resultCount,
      rawData: Array.isArray(queryResults) && queryResults.length > 1 ? queryResults : null
    });

  } catch (error) {
    console.error('Chat error:', error);

    let errorMessage = `## Error\n\nI encountered an error processing your request.\n\n`;

    if (error.message.includes('overloaded') || error.message.includes('503')) {
      errorMessage += `## Service Overloaded\n\nThe AI service is experiencing high demand. Please try again in a moment.\n\n`;
      errorMessage += `What to do:\n- Wait 10-15 seconds and try again\n- Try a simpler query\n- Contact support if the issue persists`;
    } else if (error.message.includes('Gemini') || error.message.includes('API')) {
      errorMessage += `## AI Service Issue\n\nThere was an issue with the AI service. Please try again.\n\n`;
      errorMessage += `What to do:\n- Wait a few seconds and try again\n- Try a simpler query\n- Contact support if the issue persists`;
    } else if (error.message.includes('MongoDB') || error.message.includes('database')) {
      errorMessage += `## Database Connection Issue\n\nThere was a problem connecting to the database. Please try again.\n\n`;
      errorMessage += `What to do:\n- Refresh the page\n- Try again in a few seconds\n- Contact support if the issue persists`;
    } else if (error.message.includes('JSON') || error.message.includes('parse')) {
      errorMessage += `## Query Understanding Error\n\nI had trouble understanding your query. Could you rephrase it?\n\n`;
      errorMessage += `Examples:\n- List all students\n- Show BBA subjects\n- What is [student name]'s attendance?`;
    } else {
      errorMessage += `Error Details:\n${error.message}\n\n`;
      errorMessage += `What to try:\n- Rephrase your question\n- Try a simpler query\n- Check your spelling\n- Try again later`;
    }

    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});


// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================

router.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'Online',
    message: 'Academic Assistant is ready!',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    serverTime: new Date().toLocaleString('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }),
    features: [
      'Student Search by Name/ID/Stream',
      'Subject Information & Statistics',
      'Attendance Records & History',
      'Detailed Attendance Reports',
      'Teacher Information & Subjects',
      'Statistical Queries & Analytics',
      'Natural Language Processing',
      'Smart Error Handling'
    ],
    exampleQueries: [
      'List all students',
      'Show BBA semester 5 subjects',
      'What is [student name]\'s attendance?',
      'Show attendance on 2025-10-22',
      'How many students in BCA?',
      'Who teaches Business Data Analytics?'
    ]
  });
});


module.exports = router;
