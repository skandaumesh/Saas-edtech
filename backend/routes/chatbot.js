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

  // Calculate overall stats
  const totalClasses = data.reduce((sum, s) => sum + (s.totalClasses || 0), 0);
  const totalAttended = data.reduce((sum, s) => sum + (s.classesAttended || 0), 0);
  const overallPct = totalClasses > 0 ? ((totalAttended / totalClasses) * 100).toFixed(1) : '0.0';
  const pct = parseFloat(overallPct);
  const shortages = data.filter(s => (s.attendancePercentage || 0) < 75);

  // Sort: worst attendance first
  const sorted = [...data].sort((a, b) => (a.attendancePercentage || 0) - (b.attendancePercentage || 0));

  // Status emoji
  const statusIcon = pct >= 75 ? '✅' : pct >= 50 ? '⚠️' : '🔴';

  let response = `${statusIcon} **${student.studentName}** — **${overallPct}%** overall attendance\n`;
  response += `> ${student.stream} Sem ${student.semester} • ${totalAttended}/${totalClasses} classes • ${shortages.length > 0 ? `${shortages.length} subject${shortages.length > 1 ? 's' : ''} below 75%` : 'All subjects above 75%'}\n\n`;

  // Single clean table
  response += `| Subject | Attended | % | Status |\n`;
  response += `|---------|:--------:|:---:|:------:|\n`;

  sorted.forEach(subject => {
    const sPct = (subject.attendancePercentage || 0).toFixed(1);
    const attended = subject.classesAttended || 0;
    const total = subject.totalClasses || 0;
    let status;
    if (sPct >= 90) status = '🟢 Excellent';
    else if (sPct >= 75) status = '🟢 Good';
    else if (sPct >= 50) status = '🟡 Low';
    else status = '🔴 Critical';
    response += `| ${subject.subject || 'Unknown'} | ${attended}/${total} | ${sPct}% | ${status} |\n`;
  });

  // Brief action note only if there are shortages
  if (shortages.length > 0) {
    const worst = sorted[0];
    const needed = Math.max(0, Math.ceil((75 * (worst.totalClasses || 0) - 100 * (worst.classesAttended || 0)) / 25));
    response += `\n⚠️ **Focus on ${worst.subject}** — needs ${needed} more classes to reach 75%.`;
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
    // SMART FOLLOW-UP & PRONOUN RESOLUTION
    // ================================================================
    let resolvedQuery = userQuery;
    const lowerQuery = userQuery.toLowerCase().trim();

    if (conversationHistory.length > 0) {
      // STEP A: Extract the last discussed person's name from conversation
      let lastPersonName = null;
      let lastPersonType = null; // 'student' or 'teacher'

      // Search through assistant responses for names
      const assistantMsgs = conversationHistory.filter(m => m.role === 'assistant');
      if (assistantMsgs.length > 0) {
        const lastReply = assistantMsgs[assistantMsgs.length - 1].content || '';

        // Try to extract name from AI response patterns
        const namePatterns = [
          /(?:student\s+(?:record\s+)?(?:for|named?)\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/,
          /\*\*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\*\*/,
          /(?:Name|Student):\s*(.+?)(?:\n|$)/,
          /found\s+(?:the\s+)?(?:student\s+)?(?:record\s+for\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
          /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:is a|is an|teaches|is currently|is enrolled|has an?)/i,
          /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)'s\s+(?:profile|attendance|report|details)/i,
        ];

        const skipWords = ['The', 'Here', 'This', 'However', 'Based', 'Unfortunately', 'Overall', 'Dear', 'Please', 'Today', 'Since', 'Smart', 'Error', 'Student', 'Teacher', 'MLA', 'Academy', 'I', 'As', 'There', 'No', 'What'];

        for (const p of namePatterns) {
          const m = lastReply.match(p);
          if (m && m[1] && m[1].length > 2 && !skipWords.includes(m[1].split(' ')[0])) {
            lastPersonName = m[1].trim();
            // Determine type
            if (lastReply.toLowerCase().includes('teacher') || lastReply.toLowerCase().includes('faculty') || lastReply.toLowerCase().includes('teaches') || lastReply.toLowerCase().includes('email')) {
              lastPersonType = 'teacher';
            } else {
              lastPersonType = 'student';
            }
            break;
          }
        }
      }

      // Also check user's previous messages for "who is X" or "find X"
      if (!lastPersonName) {
        const userMsgs = conversationHistory.filter(m => m.role === 'user');
        if (userMsgs.length > 0) {
          const lastUserQ = userMsgs[userMsgs.length - 1].content || '';
          const userNameMatch = lastUserQ.match(/(?:who\s+is|find|show|about)\s+(\w+(?:\s+\w+)?)/i);
          if (userNameMatch && userNameMatch[1].length > 2) {
            lastPersonName = userNameMatch[1].trim();
            lastPersonName = lastPersonName.charAt(0).toUpperCase() + lastPersonName.slice(1).toLowerCase();
          }
        }
      }

      console.log(`📌 Context: lastPerson="${lastPersonName}", type="${lastPersonType}"`);

      // STEP B: Resolve pronouns (his, her, he, she, their, them)
      const hasPronoun = /\b(his|her|he|she|their|them|this student|this teacher|that student|that teacher)\b/i.test(lowerQuery);

      if (hasPronoun && lastPersonName) {
        // Replace pronouns with the actual name
        let resolved = userQuery;

        if (lowerQuery.includes('attendance') || lowerQuery.includes('report')) {
          resolved = `Show attendance report for ${lastPersonName}`;
        } else if (lowerQuery.includes('class') || lowerQuery.includes('took') || lowerQuery.includes('teach')) {
          if (lastPersonType === 'teacher') {
            resolved = `Which classes did ${lastPersonName} take today`;
          } else {
            resolved = `Show attendance report for ${lastPersonName}`;
          }
        } else if (lowerQuery.includes('subject')) {
          resolved = `What subjects does ${lastPersonName} teach`;
        } else if (lowerQuery.includes('detail') || lowerQuery.includes('info')) {
          resolved = `Show details for ${lastPersonName}`;
        } else {
          // Generic: replace pronoun with name
          resolved = lowerQuery
            .replace(/\b(his|her|their)\b/gi, `${lastPersonName}'s`)
            .replace(/\b(he|she|them|this student|this teacher|that student|that teacher)\b/gi, lastPersonName);
        }

        resolvedQuery = resolved;
        console.log(`🔄 Pronoun resolved: "${userQuery}" -> "${resolvedQuery}"`);
      }

      // STEP C: Handle explicit follow-up patterns like "what about X", "and for X"
      if (!hasPronoun) {
        const followUpPatterns = [
          /^(?:what about|how about|and for|also|same for|check for|show for|now for|now check)\s+(.+)/i,
        ];

        for (const pattern of followUpPatterns) {
          const match = lowerQuery.match(pattern);
          if (match && match[1]) {
            const newSubject = match[1].trim();
            const lastUserMessages = conversationHistory.filter(m => m.role === 'user');
            if (lastUserMessages.length > 0) {
              const lastQuestion = (lastUserMessages[lastUserMessages.length - 1].content || '').toLowerCase();

              if (lastQuestion.includes('attendance') || lastQuestion.includes('report')) {
                resolvedQuery = `Show attendance report for ${newSubject}`;
              } else if (lastQuestion.includes('subject') || lastQuestion.includes('course')) {
                resolvedQuery = `Show subjects for ${newSubject}`;
              } else {
                resolvedQuery = `Show details for ${newSubject}`;
              }
              console.log(`🔄 Follow-up resolved: "${userQuery}" -> "${resolvedQuery}"`);
            }
            break;
          }
        }
      }

      // STEP D: Handle affirmative responses (yes, sure, ok, yeah)
      const affirmatives = ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'yea', 'ya', 'y', 'please', 'go ahead', 'do it'];
      if (affirmatives.includes(lowerQuery.replace(/[!.?,]/g, '').trim()) && lastPersonName) {
        // Check what the AI last suggested
        const lastAI = (conversationHistory.filter(m => m.role === 'assistant').pop()?.content || '').toLowerCase();

        if (lastAI.includes('attendance') || lastAI.includes('report') || lastAI.includes('academic performance')) {
          resolvedQuery = `Show attendance report for ${lastPersonName}`;
        } else if (lastAI.includes('subject') || lastAI.includes('class')) {
          resolvedQuery = `Show subjects for ${lastPersonName}`;
        } else if (lastAI.includes('detail') || lastAI.includes('more info')) {
          resolvedQuery = `Show details for ${lastPersonName}`;
        } else {
          resolvedQuery = `Show attendance report for ${lastPersonName}`;
        }
        console.log(`🔄 Affirmative resolved: "${userQuery}" -> "${resolvedQuery}"`);
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

      // Inject current date/time for context
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const timeStr = now.toLocaleTimeString('en-US');

      // Use conversation history for context-aware responses
      const conversationalResponse = await geminiService.generateResponseWithHistory(`
You are a friendly college AI assistant. The user said: "${userQuery}"

IMPORTANT: Today's date is ${dateStr}. Only mention the date if the user asks about it. Do NOT include date/time in every response.

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

    // ================================================================
    // SMART CONTEXT INJECTION: If conversation is about a teacher,
    // add teacherName filter to attendance queries BEFORE execution
    // ================================================================
    if (queryInfo.collection === 'attendance' && queryInfo.operation === 'find' && conversationHistory.length > 0) {
      // Extract teacher name from conversation context
      let contextTeacher = null;

      // Check recent assistant messages for teacher info
      const recentAssistant = [...conversationHistory].reverse().find(m => m.role === 'assistant');
      if (recentAssistant && recentAssistant.content) {
        // Look for bold names or "teacher" mentions
        const patterns = [
          /\*\*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\*\*/,
          /(?:Dr\.\s*)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:is a|teaches|is associated|is an?\s)/i,
          /(?:teacher|faculty|professor)\s*:?\s*(?:Dr\.\s*)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
        ];
        for (const p of patterns) {
          const m = recentAssistant.content.match(p);
          if (m && m[1] && m[1].length > 2 && !['The', 'Here', 'This', 'However', 'Based', 'Unfortunately', 'Overall', 'Dear', 'Please'].includes(m[1])) {
            contextTeacher = m[1].trim();
            break;
          }
        }
      }

      // Also check user's previous messages
      if (!contextTeacher) {
        const userMsgs = conversationHistory.filter(m => m.role === 'user');
        for (let i = userMsgs.length - 1; i >= Math.max(0, userMsgs.length - 2); i--) {
          const msg = userMsgs[i].content.toLowerCase();
          // Check if user mentioned "who is X" pattern
          const whoMatch = msg.match(/who\s+is\s+(\w+)/i);
          if (whoMatch) {
            contextTeacher = whoMatch[1].charAt(0).toUpperCase() + whoMatch[1].slice(1);
            break;
          }
        }
      }

      // Inject the teacher filter into the query
      if (contextTeacher && (lowerQuery.includes('class') || lowerQuery.includes('took') || lowerQuery.includes('teach') || lowerQuery.includes('he ') || lowerQuery.includes('she ') || lowerQuery.includes('his ') || lowerQuery.includes('her ') || lowerQuery.includes('kamala') || lowerQuery.includes('today'))) {
        console.log(`🎯 Context injection: Looking up teacher "${contextTeacher}" for attendance filter`);

        // Look up the teacher's email from the teachers collection
        try {
          const { getDB } = require('../config/database');
          const db = getDB();
          const teacher = await db.collection('teachers').findOne({
            name: { $regex: contextTeacher, $options: 'i' }
          });

          if (teacher && teacher.email) {
            console.log(`✅ Found teacher email: ${teacher.email}`);
            const teacherFilter = {
              $or: [
                { teacherEmail: { $regex: teacher.email, $options: 'i' } },
                { teacherName: { $regex: contextTeacher, $options: 'i' } }
              ]
            };

            if (typeof queryInfo.query === 'object' && !Array.isArray(queryInfo.query)) {
              Object.assign(queryInfo.query, teacherFilter);
            } else if (Array.isArray(queryInfo.query)) {
              const matchStage = queryInfo.query.find(s => s.$match);
              if (matchStage) {
                Object.assign(matchStage.$match, teacherFilter);
              } else {
                queryInfo.query.unshift({ $match: teacherFilter });
              }
            }
          } else {
            console.log(`⚠️ Teacher "${contextTeacher}" not found in teachers collection, using name filter`);
            // Fallback: try both fields
            const fallbackFilter = {
              $or: [
                { teacherName: { $regex: contextTeacher, $options: 'i' } },
                { teacherEmail: { $regex: contextTeacher, $options: 'i' } }
              ]
            };
            if (typeof queryInfo.query === 'object' && !Array.isArray(queryInfo.query)) {
              Object.assign(queryInfo.query, fallbackFilter);
            }
          }
        } catch (lookupErr) {
          console.log(`⚠️ Teacher lookup failed:`, lookupErr.message);
        }
      }
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

    // ================================================================
    // SMART AUTO-RETRY: If no results, try harder before giving up
    // ================================================================
    if (!queryResults ||
      (Array.isArray(queryResults) && queryResults.length === 0)) {

      console.log('⚠️ No results from initial query. Attempting smart retry...');

      // Extract student name from the original query for retry
      const namePatterns = [
        /(?:attendance|report|details|info)\s+(?:of|for)\s+(.+?)(?:\?|$)/i,
        /(?:show|find|get|search)\s+(.+?)(?:'s|\s+attendance|\s+report|\s+details|\?|$)/i,
        /(.+?)(?:'s|s')\s+(?:attendance|report|details)/i,
        /(?:what about|how about|and for|check for)\s+(.+?)(?:\?|$)/i
      ];

      let retryName = null;
      for (const pattern of namePatterns) {
        const match = resolvedQuery.match(pattern);
        if (match && match[1]) {
          retryName = match[1].trim().replace(/^(?:student|named?)\s+/i, '');
          if (retryName.length > 2) break;
          retryName = null;
        }
      }

      if (retryName) {
        console.log(`🔄 Smart retry: Searching database directly for "${retryName}"...`);

        try {
          const { getDB } = require('../config/database');
          const db = getDB();

          // Direct fuzzy search in students collection with smart regex
          let retryRegexPattern = retryName;
          const retryWords = retryName.split(/\s+/).filter(w => w.length > 0);
          if (retryWords.length > 1) {
            retryRegexPattern = retryWords.map(word => `(?=.*${word})`).join('');
          }

          const studentMatch = await db.collection('students').findOne({
            name: { $regex: retryRegexPattern, $options: 'i' },
            isActive: true
          });

          if (studentMatch) {
            console.log(`✅ Smart retry found student: ${studentMatch.name}`);

            // Now build and execute the attendance query using the pre-built template
            const retryQueryInfo = queryGenerator.buildStudentAttendanceQuery
              ? queryGenerator.buildStudentAttendanceQuery(studentMatch.name)
              : {
                collection: "students",
                operation: "aggregate",
                query: [
                  { "$match": { "name": { "$regex": studentMatch.name, "$options": "i" }, "isActive": true } },
                  { "$limit": 1 },
                  {
                    "$lookup": {
                      "from": "attendance",
                      "let": { "studentID": "$studentID", "stream": "$stream", "semester": "$semester" },
                      "pipeline": [
                        {
                          "$match": {
                            "$expr": {
                              "$and": [
                                { "$eq": ["$stream", "$$stream"] },
                                { "$eq": ["$semester", "$$semester"] }
                              ]
                            }
                          }
                        },
                        {
                          "$group": {
                            "_id": "$subject",
                            "totalClasses": { "$sum": 1 },
                            "attended": { "$sum": { "$cond": [{ "$in": ["$$studentID", "$studentsPresent"] }, 1, 0] } }
                          }
                        },
                        {
                          "$project": {
                            "subject": "$_id", "totalClasses": 1,
                            "classesAttended": "$attended",
                            "attendancePercentage": { "$multiply": [{ "$divide": ["$attended", "$totalClasses"] }, 100] },
                            "_id": 0
                          }
                        }
                      ],
                      "as": "attendance"
                    }
                  },
                  { "$unwind": "$attendance" },
                  { "$replaceRoot": { "newRoot": { "$mergeObjects": ["$attendance", { "studentName": "$name", "studentID": "$studentID", "stream": "$stream", "semester": "$semester" }] } } }
                ],
                explanation: `Complete attendance report for ${studentMatch.name}`
              };

            const retryResults = await queryGenerator.executeQuery(retryQueryInfo);

            if (retryResults && Array.isArray(retryResults) && retryResults.length > 0) {
              console.log(`✅ Smart retry succeeded! ${retryResults.length} results`);
              // Use these results instead - continue to formatting below
              queryResults = retryResults;
              queryInfo.explanation = retryQueryInfo.explanation;
              // Don't return - fall through to the response formatting below
            } else {
              // Student exists but no attendance data
              return res.json({
                success: true,
                answer: `## Student Found: ${studentMatch.name}\n\nStudent ID: ${studentMatch.studentID}\nStream: ${studentMatch.stream} | Semester: ${studentMatch.semester}\n\n## No Attendance Records Yet\n\nThis student is registered but no attendance has been recorded yet.\n\n### Try:\n- Check all ${studentMatch.stream} students\n- View subjects for ${studentMatch.stream} Semester ${studentMatch.semester}`,
                queryInfo: { collection: 'students', operation: 'find', explanation: 'Student found, no attendance' },
                resultCount: 0
              });
            }
          } else {
            // Student not found - try fuzzy matching
            const fuzzyResults = await db.collection('students').find({
              name: { $regex: retryName.split(' ')[0], $options: 'i' },
              isActive: true
            }).limit(5).toArray();

            if (fuzzyResults.length > 0) {
              const suggestions = fuzzyResults.map(s => `- **${s.name}** (${s.stream} Sem ${s.semester})`).join('\n');
              return res.json({
                success: true,
                answer: `## Student Not Found: "${retryName}"\n\nI couldn't find an exact match, but here are similar students:\n\n${suggestions}\n\nTry asking with the exact name from the list above.`,
                queryInfo: { collection: 'students', operation: 'find', explanation: 'Fuzzy match suggestions' },
                resultCount: 0
              });
            }
          }
        } catch (retryError) {
          console.error('Smart retry failed:', retryError.message);
        }
      }

      // If we still have no results after retry, show the generic message
      if (!queryResults || (Array.isArray(queryResults) && queryResults.length === 0)) {
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
            } else {
              noResultsMessage += `## No Attendance Records in Database\n\n`;
              noResultsMessage += `There are no attendance records in the system yet.\n`;
            }
          } catch (e) {
            noResultsMessage += `## Suggestions for Attendance Search:\n\n`;
            noResultsMessage += `- Try: Show recent classes\n`;
            noResultsMessage += `- For student report: Show [student name] attendance\n`;
          }
        } else {
          noResultsMessage += `## General Suggestions:\n\n`;
          noResultsMessage += `- Try rephrasing your question\n`;
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
    }

    // ================================================================
    // STEP 3: GENERATE ACCURATE RESPONSE (DATA-DRIVEN, NOT AI-HALLUCINATED)
    // ================================================================

    // Smart pre-filter: If conversation is about a specific teacher, filter results
    if (Array.isArray(queryResults) && queryResults.length > 0 && conversationHistory.length > 0) {
      const hasTeacherField = queryResults[0].teacherName || queryResults[0].teacherEmail;

      if (hasTeacherField) {
        let contextTeacherName = null;
        const lastAssistantMsg = [...conversationHistory].reverse().find(m => m.role === 'assistant');

        if (lastAssistantMsg && lastAssistantMsg.content) {
          const teacherPatterns = [
            /(?:Dr\.\s*)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:is a|teaches|is associated|is an)/i,
            /(?:teacher|faculty|professor|dr\.?)\s*:?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
            /\*\*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\*\*/,
          ];
          const skipWords = ['The', 'Here', 'This', 'However', 'Based', 'Unfortunately', 'Overall', 'Dear', 'Please', 'Today', 'Since', 'Smart', 'Error', 'Student', 'Teacher', 'MLA', 'Academy', 'I', 'As', 'There', 'No', 'What'];
          for (const pattern of teacherPatterns) {
            const match = lastAssistantMsg.content.match(pattern);
            if (match && match[1] && match[1].length > 2 && !skipWords.includes(match[1].split(' ')[0])) {
              contextTeacherName = match[1].trim();
              break;
            }
          }
        }

        if (contextTeacherName) {
          const searchTerm = contextTeacherName.split(/[\s@]/)[0].toLowerCase();
          const filtered = queryResults.filter(r => {
            const name = (r.teacherName || '').toLowerCase();
            const email = (r.teacherEmail || '').toLowerCase();
            return name.includes(searchTerm) || email.includes(searchTerm);
          });
          if (filtered.length > 0) {
            console.log(`🎯 Smart filter: ${queryResults.length} → ${filtered.length} for "${contextTeacherName}"`);
            queryResults = filtered;
          }
        }
      }
    }

    // Check if this is an attendance report (individual student)
    const isIndividualReport = queryInfo.explanation &&
      Array.isArray(queryResults) && queryResults.length > 0 && queryResults[0].studentName &&
      (typeof queryInfo.explanation === 'string' && (queryInfo.explanation.toLowerCase().includes('attendance report') || queryInfo.explanation.toLowerCase().includes('detailed report')));

    let naturalResponse;

    try {
      // ================================================================
      // DATA-DRIVEN RESPONSE: Use code-based formatters first (100% accurate)
      // Only fall back to AI for simple conversational wrapping
      // ================================================================

      if (isIndividualReport) {
        // Use the code-based attendance report formatter - 100% accurate
        naturalResponse = formatAttendanceReport(queryResults);
        console.log('✅ Used code-based attendance report formatter (no AI hallucination)');

      } else {
        // Use queryGenerator's code-based formatters
        naturalResponse = await queryGenerator.generateNaturalResponse(userQuery, queryResults, queryInfo);
        console.log('✅ Used queryGenerator formatters (data-driven response)');
      }

    } catch (aiError) {
      console.error('Response generation failed, using fallback:', aiError.message);

      // Ultimate fallback
      if (isIndividualReport) {
        naturalResponse = formatAttendanceReport(queryResults);
      } else {
        const tableFormat = queryGenerator.formatAsTable(queryResults, queryInfo.collection, userQuery);
        if (tableFormat) {
          naturalResponse = tableFormat;
        } else {
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
      answer: (naturalResponse || 'I processed your query but could not generate a response. Please try again.').trim(),
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
    console.error('Chat error stack:', error.stack);

    const errMsg = (error && error.message) ? error.message : String(error);

    let errorMessage = `## Error\n\nI encountered an error processing your request.\n\n`;

    if (errMsg.includes('overloaded') || errMsg.includes('503')) {
      errorMessage += `## Service Overloaded\n\nThe AI service is experiencing high demand. Please try again in a moment.\n\n`;
      errorMessage += `What to do:\n- Wait 10-15 seconds and try again\n- Try a simpler query\n- Contact support if the issue persists`;
    } else if (errMsg.includes('Gemini') || errMsg.includes('API')) {
      errorMessage += `## AI Service Issue\n\nThere was an issue with the AI service. Please try again.\n\n`;
      errorMessage += `What to do:\n- Wait a few seconds and try again\n- Try a simpler query\n- Contact support if the issue persists`;
    } else if (errMsg.includes('MongoDB') || errMsg.includes('database')) {
      errorMessage += `## Database Connection Issue\n\nThere was a problem connecting to the database. Please try again.\n\n`;
      errorMessage += `What to do:\n- Refresh the page\n- Try again in a few seconds\n- Contact support if the issue persists`;
    } else if (errMsg.includes('JSON') || errMsg.includes('parse')) {
      errorMessage += `## Query Understanding Error\n\nI had trouble understanding your query. Could you rephrase it?\n\n`;
      errorMessage += `Examples:\n- List all students\n- Show BBA subjects\n- What is [student name]'s attendance?`;
    } else {
      errorMessage += `Error Details:\n${errMsg}\n\n`;
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
