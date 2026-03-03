// ============================================================================
// QUERY GENERATOR - NATURAL INTRO FOR ALL RESPONSES (COMPLETE VERSION)
// ============================================================================

const geminiService = require('./geminiService');
const { getSchemaContext } = require('../utils/schemaContext');
const { getDB } = require('../config/database');
const { ObjectId } = require('mongodb');


// ============================================================================
// PARSE DATE FROM QUERY - HANDLES ALL DATE FORMATS
// ============================================================================

function parseDateFromQuery(question) {
  // Match formats: DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, "today", "yesterday"
  const datePatterns = [
    /(\d{2})-(\d{2})-(\d{4})/,  // DD-MM-YYYY
    /(\d{2})\/(\d{2})\/(\d{4})/, // DD/MM/YYYY
    /(\d{4})-(\d{2})-(\d{2})/   // YYYY-MM-DD
  ];

  for (const pattern of datePatterns) {
    const match = question.match(pattern);
    if (match) {
      if (pattern === datePatterns[2]) {
        // Already YYYY-MM-DD
        return match[0];
      } else {
        // Convert DD-MM-YYYY or DD/MM/YYYY to YYYY-MM-DD
        return `${match[3]}-${match[2]}-${match[1]}`;
      }
    }
  }

  // Check for "today"
  if (question.toLowerCase().includes('today')) {
    return new Date().toISOString().split('T')[0];
  }

  // Check for "yesterday"
  if (question.toLowerCase().includes('yesterday')) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().split('T')[0];
  }

  return null;
}


// ============================================================================
// BUILD STUDENT ATTENDANCE QUERY - PRE-BUILT TEMPLATE
// ============================================================================

function buildStudentAttendanceQuery(studentName, specificDate = null) {
  console.log(`🎯 [Pre-built Query] Student: ${studentName}, Date: ${specificDate || 'all'}`);

  const dateFilter = specificDate
    ? [{ "$regexMatch": { "input": "$date", "regex": `^${specificDate}` } }]
    : [];

  let smartStudentNameRegex = studentName;
  if (studentName.includes(' ') && !studentName.includes('(?=')) {
    const words = studentName.split(/\s+/).filter(w => w.length > 0);
    if (words.length > 1) {
      smartStudentNameRegex = words.map(w => `(?=.*${w})`).join('');
    }
  }

  const query = [
    {
      "$match": {
        "name": { "$regex": smartStudentNameRegex, "$options": "i" },
        "isActive": true
      }
    },
    {
      "$limit": 1
    },
    {
      "$lookup": {
        "from": "attendance",
        "let": {
          "studentID": "$studentID",
          "stream": "$stream",
          "semester": "$semester"
        },
        "pipeline": [
          {
            "$match": {
              "$expr": {
                "$and": [
                  { "$eq": ["$stream", "$$stream"] },
                  { "$eq": ["$semester", "$$semester"] },
                  ...dateFilter
                ]
              }
            }
          },
          {
            "$group": {
              "_id": "$subject",
              "totalClasses": { "$sum": 1 },
              "attended": {
                "$sum": {
                  "$cond": [
                    { "$in": ["$$studentID", "$studentsPresent"] },
                    1,
                    0
                  ]
                }
              }
            }
          },
          {
            "$project": {
              "subject": "$_id",
              "totalClasses": 1,
              "classesAttended": "$attended",
              "attendancePercentage": {
                "$multiply": [
                  { "$divide": ["$attended", "$totalClasses"] },
                  100
                ]
              },
              "_id": 0
            }
          }
        ],
        "as": "attendance"
      }
    },
    // Lookup language subject names from subjects collection
    {
      "$lookup": {
        "from": "subjects",
        "let": { "stream": "$stream", "semester": "$semester" },
        "pipeline": [
          {
            "$match": {
              "$expr": {
                "$and": [
                  { "$eq": [{ "$toUpper": "$stream" }, { "$toUpper": "$$stream" }] },
                  { "$eq": ["$semester", "$$semester"] },
                  { "$eq": ["$isLanguageSubject", true] }
                ]
              }
            }
          },
          { "$project": { "name": 1, "_id": 0 } }
        ],
        "as": "languageSubjects"
      }
    },
    // Build a set of language subject names for filtering
    {
      "$addFields": {
        "langSubjectNames": { "$map": { "input": "$languageSubjects", "as": "ls", "in": { "$toUpper": "$$ls.name" } } },
        "studentLangUpper": { "$toUpper": { "$ifNull": ["$languageSubject", ""] } }
      }
    },
    {
      "$unwind": "$attendance"
    },
    // Filter: keep subject if it's NOT a language subject OR if it matches student's enrolled language
    {
      "$match": {
        "$expr": {
          "$or": [
            // Not a language subject — always include
            { "$not": { "$in": [{ "$toUpper": "$attendance.subject" }, "$langSubjectNames"] } },
            // IS a language subject AND matches the student's enrolled language
            { "$eq": [{ "$toUpper": "$attendance.subject" }, "$studentLangUpper"] }
          ]
        }
      }
    },
    {
      "$replaceRoot": {
        "newRoot": {
          "$mergeObjects": [
            "$attendance",
            {
              "studentName": "$name",
              "studentID": "$studentID",
              "stream": "$stream",
              "semester": "$semester"
            }
          ]
        }
      }
    }
  ];

  return {
    collection: "students",
    operation: "aggregate",
    query: query,
    explanation: `Complete attendance report for ${studentName}${specificDate ? ` on ${specificDate}` : ''}`
  };
}


// ============================================================================
// HELPER: EXTRACT STUDENT ID (MODULE LEVEL)
// ============================================================================
function extractStudentID(text) {
  const patterns = [
    /\b([a-zA-Z0-9]{8,15})\b/,
    /(?:ID|USN|roll)\s*(?:is|of|for)?\s*([a-zA-Z0-9]+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}


// ============================================================================
// EXECUTE QUERY WITH ENHANCED ERROR HANDLING
// ============================================================================

async function executeQuery(queryInfo) {
  const { collection, operation, query, projection } = queryInfo;

  console.log(`🔍 [Executing] ${operation} on ${collection}`);

  try {
    const db = getDB();
    if (!db) {
      throw new Error('Database not connected');
    }

    const coll = db.collection(collection);
    let results;

    // Define full projections for each collection to ensure all fields are returned
    const fullProjections = {
      students: {
        studentID: 1, name: 1, stream: 1, semester: 1, parentPhone: 1,
        mentorEmail: 1, languageSubject: 1, electiveSubject: 1, academicYear: 1, isActive: 1
      },
      teachers: {
        name: 1, email: 1, phone: 1, department: 1, createdSubjects: 1
      },
      subjects: {
        name: 1, subjectCode: 1, stream: 1, semester: 1, subjectType: 1, teacherAssigned: 1, isActive: 1
      },
      attendance: {
        stream: 1, semester: 1, subject: 1, subjectCode: 1, date: 1, time: 1,
        studentsPresent: 1, totalStudents: 1, presentCount: 1, absentCount: 1, teacherEmail: 1, teacherName: 1
      }
    };

    switch (operation) {
      case 'find':
        // ================================================================
        // SMART REGEX INTERCEPTION: Fix LLM-generated literal names
        // ================================================================
        if ((collection === 'students' || collection === 'teachers') && query && query.name && typeof query.name.$regex === 'string') {
          const originalRegex = query.name.$regex;
          // If the regex is just a literal space-separated name (no special regex chars like ?= or ^)
          if (originalRegex.includes(' ') && !originalRegex.includes('(?=')) {
            const words = originalRegex.split(/\s+/).filter(w => w.length > 0);
            if (words.length > 1) {
              const smartRegex = words.map(word => `(?=.*${word})`).join('');
              console.log(`🧠 Smart Regex Conversion: "${originalRegex}" -> "${smartRegex}"`);
              query.name.$regex = smartRegex;
            }
          }
        }

        // Use provided projection or default to full projection for the collection
        let useProjection = projection || fullProjections[collection] || null;
        
        // FORCE: Always include mentorEmail in student projections so we can resolve mentor name
        if (collection === 'students' && useProjection && !useProjection.mentorEmail) {
          useProjection = { ...useProjection, mentorEmail: 1 };
        }
        
        results = useProjection
          ? await coll.find(query).project(useProjection).toArray()
          : await coll.find(query).toArray();
        console.log(`✅ [Results] Found ${results.length} documents`);

        // ENRICH: If student results, always resolve mentor name from mentorEmail
        if (collection === 'students' && results.length > 0 && results.length <= 50) {
          const mentorEmails = [...new Set(results.filter(r => r.mentorEmail).map(r => r.mentorEmail))];
          if (mentorEmails.length > 0) {
            const teacherColl = db.collection('teachers');
            const mentors = await teacherColl.find({ email: { $in: mentorEmails } }).project({ name: 1, email: 1 }).toArray();
            const mentorMap = {};
            mentors.forEach(m => { mentorMap[m.email] = m.name; });
            results.forEach(r => {
              if (r.mentorEmail && mentorMap[r.mentorEmail]) {
                r.mentorName = mentorMap[r.mentorEmail];
              } else if (!r.mentorEmail) {
                r.mentorName = 'Not Assigned';
              }
            });
            console.log(`✅ [Mentor Enrichment] Resolved ${mentorEmails.length} mentor names`);
          } else {
            // No mentorEmail on any result — mark all as not assigned
            results.forEach(r => { r.mentorName = 'Not Assigned'; });
          }
        }

        // FALLBACK: If Student search yields no results, try Teachers
        if (results.length === 0 && collection === 'students' && query.name && query.name.$regex) {
          const nameRegex = query.name.$regex;
          console.log(`⚠️ Student search empty. Checking Teachers collection for "${nameRegex}"...`);
          const teacherColl = db.collection('teachers');
          const teacherResults = await teacherColl.find({ name: { $regex: nameRegex, $options: 'i' } }).toArray();

          if (teacherResults.length > 0) {
            console.log(`✅ Found ${teacherResults.length} matches in Teachers! Returning teacher data.`);
            results = teacherResults;
            // Note: friendlyFormatResults auto-detects teachers based on 'email' field presence
          }
        }
        break;

      case 'countDocuments':
        results = await coll.countDocuments(query);
        console.log(`✅ [Results] Count: ${results}`);
        break;

      case 'aggregate':
        // ================================================================
        // SMART REGEX INTERCEPTION: Fix LLM-generated literal names in aggregations
        // ================================================================
        if ((collection === 'students' || collection === 'teachers') && Array.isArray(query)) {
          const matchStage = query.find(s => s.$match && s.$match.name && typeof s.$match.name.$regex === 'string');
          if (matchStage) {
            const originalRegex = matchStage.$match.name.$regex;
            if (originalRegex.includes(' ') && !originalRegex.includes('(?=')) {
              const words = originalRegex.split(/\s+/).filter(w => w.length > 0);
              if (words.length > 1) {
                const smartRegex = words.map(word => `(?=.*${word})`).join('');
                console.log(`🧠 Smart Regex Conversion (Aggregate): "${originalRegex}" -> "${smartRegex}"`);
                matchStage.$match.name.$regex = smartRegex;
              }
            }
          }
        }

        results = await coll.aggregate(query).toArray();
        console.log(`✅ [Results] Aggregation returned ${results.length} documents`);

        if (results.length === 0 && collection === 'students') {
          const queryStr = JSON.stringify(query);
          const studentNameMatch = queryStr.match(/"name":\s*\{\s*"\$regex"\s*:\s*"([^"]+)"/);

          if (studentNameMatch) {
            const studentName = studentNameMatch[1];
            console.log(`⚠️ No attendance data found for "${studentName}", checking if student exists...`);

            const studentColl = db.collection('students');
            const studentExists = await studentColl.findOne({
              name: { $regex: studentName, $options: 'i' },
              isActive: true
            });

            if (studentExists) {
              console.log(`✅ Student found: ${studentExists.name} (${studentExists.studentID})`);

              const attendanceColl = db.collection('attendance');
              const attendanceCount = await attendanceColl.countDocuments({
                stream: studentExists.stream,
                semester: studentExists.semester
              });

              if (attendanceCount === 0) {
                throw new Error(`NO_ATTENDANCE_RECORDS:${studentExists.name}:${studentExists.stream}:${studentExists.semester}`);
              } else {
                throw new Error(`STUDENT_EXISTS_NO_ATTENDANCE:${studentExists.name}:${studentExists.stream}:${studentExists.semester}:${studentExists.studentID}`);
              }
            } else {
              console.log(`❌ Student "${studentName}" not found in database`);
              throw new Error(`STUDENT_NOT_FOUND:${studentName}`);
            }
          }
        }
        break;

      default:
        throw new Error(`Unsupported operation: ${operation}`);
    }

    return results;

  } catch (error) {
    console.error(`❌ [Query Error]:`, error.message);
    throw error;
  }
}


// ============================================================================
// GENERATE MONGO QUERY - OPTIMIZED WITH PRE-BUILT TEMPLATES
// ============================================================================

async function generateMongoQuery(question) {
  console.log(`📝 [Query Generator] Question: ${question}`);

  const schemaContext = getSchemaContext();

  const now = new Date();
  const currentDate = now.toISOString().split('T')[0];
  const currentDateTime = now.toISOString().replace('T', ' ').substring(0, 19);

  // Parse date if present
  const parsedDate = parseDateFromQuery(question);
  const lowerQuestion = question.toLowerCase();

  // =========== HELPER: DETECT STREAM ===========
  function detectStream(text) {
    const lowerText = text.toLowerCase();
    // Check for "BCom A&F" pattern first
    const bcomAFMatch = text.match(/bcom\s*a\s*&?\s*f/i);
    if (bcomAFMatch) return "BCom A&F";

    const knownStreams = ['bca', 'bba', 'bcom', 'mca', 'mba', 'bda', 'bsc', 'ba', 'btech', 'mtech', 'msc', 'ma'];
    const streamPatterns = lowerText.match(/\b([a-z]{2,5})\b/gi) || [];
    for (const word of streamPatterns) {
      if (knownStreams.includes(word.toLowerCase())) {
        return word.toUpperCase();
      }
    }
    return null;
  }

  // =========== HELPER: DETECT SEMESTER ===========
  function detectSemester(text) {
    const semPatterns = [/sem(?:ester)?\s*(\d)/i, /(\d)(?:st|nd|rd|th)?\s*sem/i, /\bsem(\d)\b/i];
    for (const pattern of semPatterns) {
      const match = text.match(pattern);
      if (match) return parseInt(match[1]);
    }
    return null;
  }

  // =========== HELPER: EXTRACT SUBJECT NAME ===========
  function extractSubjectName(text) {
    const patterns = [
      /(?:who\s+teaches|teacher\s+(?:of|for)|teaches)\s+(.+?)(?:\s+subject|\s+class|\s+in|\?|$)/i,
      /(.+?)\s+(?:subject|class)\s+teacher/i,
      /subject\s+(.+?)(?:\s+teacher|\?|$)/i,
      /(?:who|which)\s+teacher\s+(?:is|for|takes)\s+(.+?)(?:\?|$)/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1].trim();
    }
    return null;
  }

  // =========== HELPER: EXTRACT STUDENT NAME ===========
  function extractStudentName(text) {
    const patterns = [
      /(?:who\s+is|tell\s+me\s+about)\s+(?:the\s+)?(?:student\s+)?(.+?)(?:\?|$)/i,
      /(?:student|find|search|get|show)\s+(.+?)(?:'s|\s+attendance|\s+details|\s+info|\?|$)/i,
      /(?:attendance|report|details|info)\s+(?:of|for)\s+(.+?)(?:\?|$)/i,
      /(.+?)(?:'s|s')\s+(?:attendance|report|details)/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        let name = match[1].trim();
        name = name.replace(/^(?:student|named?)\s+/i, '');
        if (name.length > 2) {
          // Convert to a smart regex pattern that matches all words regardless of order or middle names
          // e.g. "tanisha karve" -> "(?=.*tanisha)(?=.*karve)"
          const words = name.split(/\s+/).filter(w => w.length > 0);
          if (words.length > 1) {
            return words.map(word => `(?=.*${word})`).join('');
          }
          return name;
        }
      }
    }
    return null;
  }

  // =========== HELPER: EXTRACT TEACHER NAME ===========
  function extractTeacherName(text) {
    const patterns = [
      /(?:who\s+is|tell\s+me\s+about)\s+(?:the\s+)?(?:teacher\s+)?(.+?)(?:\?|$)/i,
      /(?:find|search|get|show|details|info|about)\s+(?:the\s+)?teacher\s+(?:named\s+)?(.+?)(?:\?|$)/i,
      /teacher\s+(?:named?\s+)?(.+?)(?:\s+details|\s+info|\s+email|\s+contact|\s+subjects|\s+performance|\s+report|\?|$)/i,
      /(?:details|info|profile|data)\s+(?:of|for|about)\s+(?:teacher\s+)?(.+?)(?:\?|$)/i,
      /(?:email|contact)\s+(?:of|for)\s+(?:teacher\s+)?(.+?)(?:\?|$)/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        let name = match[1].trim();
        // Remove common trailing words
        name = name.replace(/\s+(?:teacher|sir|madam|mam|ma'am)$/i, '');
        if (name.length > 2) return name;
      }
    }
    return null;
  }

  // =========== HELPER: EXTRACT STUDENT ID (USN) ===========
  function extractStudentID(text) {
    // USN patterns usually start with a letter (like 1AY...) or just digits
    const patterns = [
      /\b([a-zA-Z0-9]{8,15})\b/, // Typical USN format
      /(?:ID|USN|roll)\s*(?:is|of|for)?\s*([a-zA-Z0-9]+)/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1].toUpperCase();
    }
    return null;
  }

  // Common stream and semester detection
  const detectedStream = detectStream(question);
  const detectedSemester = detectSemester(question);

  // =========== MENTORSHIP QUERIES (HIGH PRIORITY) ===========

  // 1. Who is the mentor for student?
  if (lowerQuestion.match(/(?:who|which\s+teacher)\s+is\s+(?:the\s+)?mentor\s+(?:for|of)\s+|mentor\s+(?:for|of)\s+.+(?:\?|$)/i)) {
    const studentNameFromMentor = (question.match(/mentor\s+(?:for|of)\s+([^?]+)/i) || [])[1] ||
      extractStudentName(question);
    const studentIDFromMentor = extractStudentID(question);

    if (studentNameFromMentor || studentIDFromMentor) {
      console.log(`🎯 [Mentorship] Mentor lookup for: ${studentIDFromMentor || studentNameFromMentor}`);
      const studentMatch = studentIDFromMentor
        ? { "mentees.studentID": { "$regex": "^" + studentIDFromMentor.trim() + "$", "$options": "i" } }
        : { "mentees.name": { "$regex": studentNameFromMentor.trim(), "$options": "i" } };

      return {
        collection: "teachers",
        operation: "find",
        query: studentMatch,
        projection: { name: 1, email: 1, phone: 1, mentees: 1, _id: 0 },
        explanation: `Finding the mentor for student ${studentIDFromMentor || studentNameFromMentor}`
      };
    }
  }

  // 2. List mentees for teacher?
  if (lowerQuestion.match(/(?:list|show|all|get)\s+(?:mentees|assigned\s+students)\s+(?:for|of|under|to)\s+|mentees\s+(?:of|for)\s+/i)) {
    const teacherNameForMentees = (question.match(/mentees\s+(?:of|for)\s+([^?]+)/i) || [])[1] ||
      extractTeacherName(question);
    if (teacherNameForMentees) {
      console.log(`🎯 [Mentorship] Mentees list for: ${teacherNameForMentees.trim()}`);

      return {
        collection: "teachers",
        operation: "find",
        query: { "name": { "$regex": teacherNameForMentees.trim(), "$options": "i" } },
        projection: { name: 1, mentees: 1, _id: 0 },
        explanation: `Students assigned to ${teacherNameForMentees.trim()} for mentorship`
      };
    }
  }

  // =========== CROSS-QUERY 1: WHO WAS ABSENT ON DATE ===========
  if (lowerQuestion.match(/who\s+(?:was|were|is)\s+absent|absent\s+(?:students?|list)|absentees/i) && parsedDate) {
    console.log(`🎯 [Cross-Query] Absent students on ${parsedDate}`);

    const matchFilter = { date: { $regex: `^${parsedDate}` } };
    if (detectedStream) matchFilter.stream = { $regex: `^${detectedStream}$`, $options: 'i' };
    if (detectedSemester) matchFilter.semester = detectedSemester;

    return {
      collection: "attendance",
      operation: "aggregate",
      query: [
        { "$match": matchFilter },
        {
          "$lookup": {
            "from": "students",
            "let": { "stream": "$stream", "semester": "$semester", "present": "$studentsPresent" },
            "pipeline": [
              {
                "$match": {
                  "$expr": {
                    "$and": [
                      { "$eq": ["$stream", "$$stream"] },
                      { "$eq": ["$semester", "$$semester"] },
                      { "$eq": ["$isActive", true] },
                      { "$not": { "$in": ["$studentID", "$$present"] } }
                    ]
                  }
                }
              }
            ],
            "as": "absentStudents"
          }
        },
        { "$unwind": "$absentStudents" },
        {
          "$group": {
            "_id": "$absentStudents.studentID",
            "name": { "$first": "$absentStudents.name" },
            "studentID": { "$first": "$absentStudents.studentID" },
            "stream": { "$first": "$absentStudents.stream" },
            "semester": { "$first": "$absentStudents.semester" },
            "missedSubjects": { "$push": "$subject" },
            "missedCount": { "$sum": 1 }
          }
        },
        { "$sort": { "missedCount": -1 } },
        {
          "$project": {
            "_id": 0,
            "name": 1,
            "studentID": 1,
            "stream": 1,
            "semester": 1,
            "missedSubjects": 1,
            "missedCount": 1
          }
        }
      ],
      explanation: `Students absent on ${parsedDate}${detectedStream ? ` in ${detectedStream}` : ''}${detectedSemester ? ` Sem ${detectedSemester}` : ''}`
    };
  }

  // =========== CROSS-QUERY 2: WHO WAS PRESENT ON DATE ===========
  if (lowerQuestion.match(/who\s+(?:was|were|is)\s+present|present\s+(?:students?|list)/i) && parsedDate) {
    console.log(`🎯 [Cross-Query] Present students on ${parsedDate}`);

    const matchFilter = { date: { $regex: `^${parsedDate}` } };
    if (detectedStream) matchFilter.stream = { $regex: `^${detectedStream}$`, $options: 'i' };
    if (detectedSemester) matchFilter.semester = detectedSemester;

    return {
      collection: "attendance",
      operation: "aggregate",
      query: [
        { "$match": matchFilter },
        {
          "$lookup": {
            "from": "students",
            "let": { "stream": "$stream", "semester": "$semester", "present": "$studentsPresent" },
            "pipeline": [
              {
                "$match": {
                  "$expr": {
                    "$and": [
                      { "$eq": ["$stream", "$$stream"] },
                      { "$eq": ["$semester", "$$semester"] },
                      { "$eq": ["$isActive", true] },
                      { "$in": ["$studentID", "$$present"] }
                    ]
                  }
                }
              }
            ],
            "as": "presentStudents"
          }
        },
        { "$unwind": "$presentStudents" },
        {
          "$group": {
            "_id": "$presentStudents.studentID",
            "name": { "$first": "$presentStudents.name" },
            "studentID": { "$first": "$presentStudents.studentID" },
            "stream": { "$first": "$presentStudents.stream" },
            "semester": { "$first": "$presentStudents.semester" },
            "attendedSubjects": { "$push": "$subject" },
            "attendedCount": { "$sum": 1 }
          }
        },
        { "$sort": { "name": 1 } },
        {
          "$project": {
            "_id": 0,
            "name": 1,
            "studentID": 1,
            "stream": 1,
            "semester": 1,
            "attendedSubjects": 1,
            "attendedCount": 1
          }
        }
      ],
      explanation: `Students present on ${parsedDate}${detectedStream ? ` in ${detectedStream}` : ''}${detectedSemester ? ` Sem ${detectedSemester}` : ''}`
    };
  }

  // =========== CROSS-QUERY 3: WHO TEACHES SUBJECT ===========
  const subjectName = extractSubjectName(question);
  if ((lowerQuestion.match(/who\s+teaches|teacher\s+(?:of|for)|teaches\s+this|which\s+teacher/i) ||
    lowerQuestion.match(/who\s+is\s+(?:the\s+)?teacher/i)) && subjectName) {
    console.log(`🎯 [Cross-Query] Teacher of subject: ${subjectName}`);

    return {
      collection: "teachers",
      operation: "find",
      query: {
        "createdSubjects.subject": { "$regex": subjectName, "$options": "i" }
      },
      explanation: `Teacher who teaches ${subjectName}`
    };
  }

  // =========== CROSS-QUERY 4: "WHO IS X" - SMART SEARCH (TEACHER FIRST, THEN STUDENT) ===========
  if (lowerQuestion.match(/(?:who\s+is|tell\s+me\s+about|about)\s+(?!the\s+mentor)(.+?)(?:\?|$)/i)) {
    const whoMatch = question.match(/(?:who\s+is|tell\s+me\s+about|about)\s+(.+?)(?:\?|$)/i);
    if (whoMatch) {
      let personName = whoMatch[1].trim().replace(/^(?:student|teacher|the)\s+/i, '');
      if (personName.length > 2) {
        console.log(`🎯 [Cross-Query] Smart "who is" lookup: ${personName}`);

        // Check teachers collection FIRST
        try {
          const { getDB } = require('../config/database');
          const db = getDB();
          const teacherFound = await db.collection('teachers').findOne({
            name: { $regex: personName, $options: 'i' }
          });

          if (teacherFound) {
            console.log(`✅ Found in teachers: ${teacherFound.name}`);
            return {
              collection: "teachers",
              operation: "find",
              query: { "name": { "$regex": personName, "$options": "i" } },
              explanation: `Information about teacher ${personName}`
            };
          }
        } catch (e) {
          console.log(`⚠️ Teacher lookup error:`, e.message);
        }

        // Fall back to students
        const studentName = extractStudentName(question) || personName;
        console.log(`📌 Not found in teachers, searching students: ${studentName}`);
        return {
          collection: "students",
          operation: "find",
          query: {
            "name": { "$regex": studentName, "$options": "i" },
            "isActive": true
          },
          explanation: `Details of student ${studentName}`
        };
      }
    }
  }

  // =========== CROSS-QUERY 4B: FIND/SHOW/GET STUDENT BY NAME ===========
  if (lowerQuestion.match(/(?:find|search|get|show|details|info)\s+(?:student|of)\s+(.+)/i)) {
    const studentName = extractStudentName(question);
    if (studentName) {
      console.log(`🎯 [Cross-Query] Student details: ${studentName}`);

      return {
        collection: "students",
        operation: "find",
        query: {
          "name": { "$regex": studentName, "$options": "i" },
          "isActive": true
        },
        explanation: `Details of student ${studentName}`
      };
    }
  }

  // =========== CROSS-QUERY 5: WHICH SUBJECTS DOES TEACHER TEACH ===========
  if (lowerQuestion.match(/(?:what|which)\s+subjects?\s+(?:does|do|is)\s+(.+?)\s+teach/i) ||
    lowerQuestion.match(/subjects?\s+(?:taught|assigned)\s+(?:to|by)\s+(.+)/i)) {
    const teacherMatch = question.match(/(?:what|which)\s+subjects?\s+(?:does|do|is)\s+(.+?)\s+teach/i) ||
      question.match(/subjects?\s+(?:taught|assigned)\s+(?:to|by)\s+(.+)/i);
    if (teacherMatch) {
      const teacherName = teacherMatch[1].trim();
      console.log(`🎯 [Cross-Query] Subjects taught by: ${teacherName}`);

      return {
        collection: "teachers",
        operation: "find",
        query: {
          "name": { "$regex": teacherName, "$options": "i" }
        },
        explanation: `Subjects taught by ${teacherName}`
      };
    }
  }

  // =========== CROSS-QUERY 6: ATTENDANCE OF SPECIFIC SUBJECT ON DATE ===========
  if (lowerQuestion.match(/attendance\s+(?:of|for|in)\s+.+?\s+(?:on|today|yesterday)/i) ||
    (parsedDate && lowerQuestion.match(/attendance/i))) {
    const subjectMatch = question.match(/attendance\s+(?:of|for|in)\s+(.+?)\s+(?:on|today|yesterday|class)/i);
    if (subjectMatch) {
      const subjectName = subjectMatch[1].trim();
      console.log(`🎯 [Cross-Query] Attendance of ${subjectName} on ${parsedDate || currentDate}`);

      const dateToUse = parsedDate || currentDate;
      return {
        collection: "attendance",
        operation: "find",
        query: {
          "subject": { "$regex": subjectName, "$options": "i" },
          "date": { "$regex": `^${dateToUse}` }
        },
        explanation: `Attendance of ${subjectName} on ${dateToUse}`
      };
    }
  }

  // =========== CROSS-QUERY 7: HOW MANY CLASSES TAKEN BY TEACHER ===========
  if (lowerQuestion.match(/how\s+many\s+(?:classes|sessions|lectures)\s+(?:taken|conducted)\s+(?:by|from)/i)) {
    const teacherMatch = question.match(/(?:taken|conducted)\s+(?:by|from)\s+(.+?)(?:\?|$)/i);
    if (teacherMatch) {
      const teacherName = teacherMatch[1].trim();
      console.log(`🎯 [Cross-Query] Classes taken by: ${teacherName}`);

      return {
        collection: "attendance",
        operation: "aggregate",
        query: [
          { "$match": { "teacherEmail": { "$regex": teacherName, "$options": "i" } } },
          {
            "$group": {
              "_id": { "subject": "$subject", "stream": "$stream", "semester": "$semester" },
              "totalClasses": { "$sum": 1 },
              "avgAttendance": { "$avg": { "$multiply": [{ "$divide": ["$presentCount", "$totalStudents"] }, 100] } }
            }
          },
          {
            "$project": {
              "_id": 0,
              "subject": "$_id.subject",
              "stream": "$_id.stream",
              "semester": "$_id.semester",
              "totalClasses": 1,
              "avgAttendance": { "$round": ["$avgAttendance", 1] }
            }
          },
          { "$sort": { "stream": 1, "semester": 1 } }
        ],
        explanation: `Classes taken by ${teacherName}`
      };
    }
  }

  // =========== CROSS-QUERY 8: STUDENTS WITH 100% ATTENDANCE ===========
  if (lowerQuestion.match(/100\s*%|perfect\s+attendance|full\s+attendance|never\s+absent/i)) {
    console.log(`🎯 [Cross-Query] Students with 100% attendance`);

    const matchFilter = { isActive: true };
    if (detectedStream) matchFilter.stream = { $regex: `^${detectedStream}$`, $options: 'i' };
    if (detectedSemester) matchFilter.semester = detectedSemester;

    return {
      collection: "students",
      operation: "aggregate",
      query: [
        { "$match": matchFilter },
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
                  "_id": null,
                  "totalClasses": { "$sum": 1 },
                  "attended": { "$sum": { "$cond": [{ "$in": ["$$studentID", "$studentsPresent"] }, 1, 0] } }
                }
              }
            ],
            "as": "stats"
          }
        },
        { "$unwind": { "path": "$stats", "preserveNullAndEmptyArrays": false } },
        { "$match": { "$expr": { "$eq": ["$stats.totalClasses", "$stats.attended"] } } },
        {
          "$project": {
            "_id": 0,
            "name": 1,
            "studentID": 1,
            "stream": 1,
            "semester": 1,
            "totalClasses": "$stats.totalClasses",
            "classesAttended": "$stats.attended"
          }
        },
        { "$sort": { "stream": 1, "semester": 1, "name": 1 } }
      ],
      explanation: `Students with 100% attendance${detectedStream ? ` in ${detectedStream}` : ''}${detectedSemester ? ` Sem ${detectedSemester}` : ''}`
    };
  }

  // =========== CROSS-QUERY 9: MOST/LEAST ATTENDED SUBJECTS ===========
  if (lowerQuestion.match(/most\s+attended|highest\s+attendance|best\s+attendance/i)) {
    console.log(`🎯 [Cross-Query] Most attended subjects`);

    const matchFilter = {};
    if (detectedStream) matchFilter.stream = { $regex: `^${detectedStream}$`, $options: 'i' };
    if (detectedSemester) matchFilter.semester = detectedSemester;

    return {
      collection: "attendance",
      operation: "aggregate",
      query: [
        { "$match": matchFilter },
        {
          "$group": {
            "_id": { "subject": "$subject", "stream": "$stream", "semester": "$semester" },
            "totalSessions": { "$sum": 1 },
            "avgAttendance": { "$avg": { "$multiply": [{ "$divide": ["$presentCount", "$totalStudents"] }, 100] } }
          }
        },
        { "$sort": { "avgAttendance": -1 } },
        { "$limit": 10 },
        {
          "$project": {
            "_id": 0,
            "subject": "$_id.subject",
            "stream": "$_id.stream",
            "semester": "$_id.semester",
            "totalSessions": 1,
            "avgAttendance": { "$round": ["$avgAttendance", 1] }
          }
        }
      ],
      explanation: `Most attended subjects${detectedStream ? ` in ${detectedStream}` : ''}${detectedSemester ? ` Sem ${detectedSemester}` : ''}`
    };
  }

  if (lowerQuestion.match(/least\s+attended|lowest\s+attendance|worst\s+attendance|poor\s+subject/i)) {
    console.log(`🎯 [Cross-Query] Least attended subjects`);

    const matchFilter = {};
    if (detectedStream) matchFilter.stream = { $regex: `^${detectedStream}$`, $options: 'i' };
    if (detectedSemester) matchFilter.semester = detectedSemester;

    return {
      collection: "attendance",
      operation: "aggregate",
      query: [
        { "$match": matchFilter },
        {
          "$group": {
            "_id": { "subject": "$subject", "stream": "$stream", "semester": "$semester" },
            "totalSessions": { "$sum": 1 },
            "avgAttendance": { "$avg": { "$multiply": [{ "$divide": ["$presentCount", "$totalStudents"] }, 100] } }
          }
        },
        { "$sort": { "avgAttendance": 1 } },
        { "$limit": 10 },
        {
          "$project": {
            "_id": 0,
            "subject": "$_id.subject",
            "stream": "$_id.stream",
            "semester": "$_id.semester",
            "totalSessions": 1,
            "avgAttendance": { "$round": ["$avgAttendance", 1] }
          }
        }
      ],
      explanation: `Least attended subjects${detectedStream ? ` in ${detectedStream}` : ''}${detectedSemester ? ` Sem ${detectedSemester}` : ''}`
    };
  }

  // =========== CROSS-QUERY 10: TOTAL CLASSES HELD FOR STREAM/SEM ===========
  if (lowerQuestion.match(/how\s+many\s+(?:classes|sessions|lectures)\s+(?:held|conducted|taken)|total\s+classes/i)) {
    console.log(`🎯 [Cross-Query] Total classes held`);

    const matchFilter = {};
    if (detectedStream) matchFilter.stream = { $regex: `^${detectedStream}$`, $options: 'i' };
    if (detectedSemester) matchFilter.semester = detectedSemester;
    if (parsedDate) matchFilter.date = { $regex: `^${parsedDate}` };

    return {
      collection: "attendance",
      operation: "aggregate",
      query: [
        { "$match": matchFilter },
        {
          "$group": {
            "_id": { "subject": "$subject", "stream": "$stream", "semester": "$semester" },
            "totalClasses": { "$sum": 1 }
          }
        },
        {
          "$project": {
            "_id": 0,
            "subject": "$_id.subject",
            "stream": "$_id.stream",
            "semester": "$_id.semester",
            "totalClasses": 1
          }
        },
        { "$sort": { "stream": 1, "semester": 1, "subject": 1 } }
      ],
      explanation: `Total classes held${detectedStream ? ` for ${detectedStream}` : ''}${detectedSemester ? ` Sem ${detectedSemester}` : ''}`
    };
  }

  // =========== CROSS-QUERY 11: TEACHERS LIST ===========
  if (lowerQuestion.match(/(?:list|show|get|all|display)\s+(?:all\s+)?teachers?|teachers?\s+(?:list|in|of|names?)|teacher\s*names?|(?:all|every)\s+teacher\s*names?|who\s+are\s+(?:the\s+)?teachers/i)) {
    console.log(`🎯 [Cross-Query] Teachers list`);

    return {
      collection: "teachers",
      operation: "find",
      query: {},
      projection: { name: 1, email: 1, createdSubjects: 1, _id: 0 },
      explanation: `List of all teachers`
    };
  }

  // =========== CROSS-QUERY 12: TEACHER INFO BY NAME ===========
  const teacherNameMatch = extractTeacherName(question);
  if (teacherNameMatch && lowerQuestion.match(/who\s+is|about|teacher|info|tell|details/i)) {
    console.log(`🎯 [Cross-Query] Teacher info: ${teacherNameMatch}`);

    return {
      collection: "teachers",
      operation: "find",
      query: { "name": { "$regex": teacherNameMatch, "$options": "i" } },
      explanation: `Information about teacher ${teacherNameMatch}`
    };
  }

  // =========== CROSS-QUERY 12A: TEACHERS BY STREAM ===========
  if (lowerQuestion.match(/teachers?\s+(?:in|of|for|teaching)\s+/i) && detectedStream) {
    console.log(`🎯 [Cross-Query] Teachers in stream: ${detectedStream}`);

    return {
      collection: "teachers",
      operation: "find",
      query: {
        "createdSubjects.stream": { "$regex": `^${detectedStream}$`, "$options": "i" }
      },
      projection: { name: 1, email: 1, createdSubjects: 1, _id: 0 },
      explanation: `Teachers teaching in ${detectedStream}`
    };
  }

  // =========== CROSS-QUERY 12B: TEACHER EMAIL LOOKUP ===========
  if (lowerQuestion.match(/(?:email|contact|mail)\s+(?:of|for|id)\s+(?:teacher\s+)?/i) ||
    lowerQuestion.match(/teacher.+(?:email|contact|mail)/i)) {
    const nameForEmail = extractTeacherName(question) ||
      (question.match(/(?:email|contact|mail)\s+(?:of|for|id)\s+(?:teacher\s+)?(.+?)(?:\?|$)/i) || [])[1];
    if (nameForEmail) {
      console.log(`🎯 [Cross-Query] Teacher email: ${nameForEmail.trim()}`);

      return {
        collection: "teachers",
        operation: "find",
        query: { "name": { "$regex": nameForEmail.trim(), "$options": "i" } },
        projection: { name: 1, email: 1, _id: 0 },
        explanation: `Email of teacher ${nameForEmail.trim()}`
      };
    }
  }

  // =========== CROSS-QUERY 12C: HOW MANY SUBJECTS DOES TEACHER TEACH ===========
  if (lowerQuestion.match(/how\s+many\s+subjects?\s+(?:does|do|is|did)\s+(.+?)\s+(?:teach|have|handle)/i)) {
    const match = question.match(/how\s+many\s+subjects?\s+(?:does|do|is|did)\s+(.+?)\s+(?:teach|have|handle)/i);
    if (match) {
      const tName = match[1].trim();
      console.log(`🎯 [Cross-Query] Subject count for teacher: ${tName}`);

      return {
        collection: "teachers",
        operation: "find",
        query: { "name": { "$regex": tName, "$options": "i" } },
        projection: { name: 1, createdSubjects: 1, _id: 0 },
        explanation: `Number of subjects taught by ${tName}`
      };
    }
  }

  // =========== CROSS-QUERY 12D: WHICH TEACHER TOOK CLASS ON DATE ===========
  if (lowerQuestion.match(/(?:which|who)\s+(?:teacher|took|conducted|held)\s+(?:class|session|lecture)/i) && parsedDate) {
    console.log(`🎯 [Cross-Query] Teacher who took class on ${parsedDate}`);

    const matchFilter = { "date": { "$regex": `^${parsedDate}` } };
    if (detectedStream) matchFilter.stream = { "$regex": `^${detectedStream}$`, "$options": "i" };
    if (detectedSemester) matchFilter.semester = detectedSemester;

    return {
      collection: "attendance",
      operation: "aggregate",
      query: [
        { "$match": matchFilter },
        {
          "$group": {
            "_id": "$teacherEmail",
            "subjects": { "$addToSet": "$subject" },
            "totalSessions": { "$sum": 1 }
          }
        },
        {
          "$project": {
            "_id": 0,
            "teacherEmail": "$_id",
            "subjects": 1,
            "totalSessions": 1
          }
        },
        { "$sort": { "totalSessions": -1 } }
      ],
      explanation: `Teachers who took classes on ${parsedDate}`
    };
  }

  // =========== CROSS-QUERY 12E: MOST ACTIVE TEACHER ===========
  if (lowerQuestion.match(/most\s+(?:active|classes|sessions|lectures)|top\s+teacher|best\s+teacher|teacher\s+(?:ranking|leaderboard)|teacher\s+with\s+(?:most|highest)/i)) {
    console.log(`🎯 [Cross-Query] Most active teacher`);

    return {
      collection: "attendance",
      operation: "aggregate",
      query: [
        {
          "$group": {
            "_id": "$teacherEmail",
            "totalClasses": { "$sum": 1 },
            "totalPresent": { "$sum": "$presentCount" },
            "totalStudents": { "$sum": "$totalStudents" },
            "subjects": { "$addToSet": "$subject" }
          }
        },
        {
          "$project": {
            "_id": 0,
            "teacherEmail": "$_id",
            "totalClasses": 1,
            "subjects": 1,
            "avgAttendance": {
              "$cond": [
                { "$gt": ["$totalStudents", 0] },
                { "$round": [{ "$multiply": [{ "$divide": ["$totalPresent", "$totalStudents"] }, 100] }, 1] },
                0
              ]
            }
          }
        },
        { "$sort": { "totalClasses": -1 } },
        { "$limit": 10 }
      ],
      explanation: `Top teachers by number of classes conducted`
    };
  }

  // =========== CROSS-QUERY 12F: TEACHERS WITH NO SUBJECTS ===========
  if (lowerQuestion.match(/teachers?\s+(?:with\s+)?(?:no|zero|without)\s+subjects?|unassigned\s+teachers?|teachers?\s+not\s+(?:assigned|teaching)/i)) {
    console.log(`🎯 [Cross-Query] Teachers with no subjects`);

    return {
      collection: "teachers",
      operation: "find",
      query: {
        "$or": [
          { "createdSubjects": { "$exists": false } },
          { "createdSubjects": { "$size": 0 } }
        ]
      },
      projection: { name: 1, email: 1, _id: 0 },
      explanation: `Teachers with no subjects assigned`
    };
  }

  // =========== CROSS-QUERY 12G: TEACHER ATTENDANCE PERFORMANCE ===========
  if (lowerQuestion.match(/(?:teacher|faculty).+(?:performance|stats|statistics|record|report)/i) ||
    lowerQuestion.match(/(?:performance|stats|statistics|record|report)\s+(?:of|for)\s+(?:teacher|faculty)/i)) {
    const perfName = extractTeacherName(question) ||
      (question.match(/(?:performance|stats|record|report)\s+(?:of|for)\s+(.+?)(?:\?|$)/i) || [])[1];
    if (perfName) {
      console.log(`🎯 [Cross-Query] Teacher performance: ${perfName.trim()}`);

      return {
        collection: "attendance",
        operation: "aggregate",
        query: [
          { "$match": { "teacherEmail": { "$regex": perfName.trim(), "$options": "i" } } },
          {
            "$group": {
              "_id": { "subject": "$subject", "stream": "$stream", "semester": "$semester" },
              "totalClasses": { "$sum": 1 },
              "totalPresent": { "$sum": "$presentCount" },
              "totalStudents": { "$sum": "$totalStudents" },
              "lastClass": { "$max": "$date" }
            }
          },
          {
            "$project": {
              "_id": 0,
              "subject": "$_id.subject",
              "stream": "$_id.stream",
              "semester": "$_id.semester",
              "totalClasses": 1,
              "avgAttendance": {
                "$cond": [
                  { "$gt": ["$totalStudents", 0] },
                  { "$round": [{ "$multiply": [{ "$divide": ["$totalPresent", "$totalStudents"] }, 100] }, 1] },
                  0
                ]
              },
              "lastClass": 1
            }
          },
          { "$sort": { "stream": 1, "semester": 1 } }
        ],
        explanation: `Teaching performance report for ${perfName.trim()}`
      };
    }
  }

  // =========== CROSS-QUERY 12H: TEACHER'S COMPLETED CLASSES ===========
  if (lowerQuestion.match(/(?:completed|finished|done)\s+class(?:es)?\s+(?:by|of|for)/i) ||
    lowerQuestion.match(/teacher.+completed/i)) {
    const compName = extractTeacherName(question) ||
      (question.match(/(?:completed|finished|done)\s+class(?:es)?\s+(?:by|of|for)\s+(.+?)(?:\?|$)/i) || [])[1];
    if (compName) {
      console.log(`🎯 [Cross-Query] Completed classes by: ${compName.trim()}`);

      return {
        collection: "teachers",
        operation: "find",
        query: { "name": { "$regex": compName.trim(), "$options": "i" } },
        projection: { name: 1, completedClasses: 1, _id: 0 },
        explanation: `Completed classes by teacher ${compName.trim()}`
      };
    }
  }

  // =========== CROSS-QUERY 13C: STUDENTS WITH NO MENTOR ===========
  if (lowerQuestion.match(/(?:students?|all)\s+(?:with|having)\s+no\s+(?:assigned\s+)?mentor/i) ||
    lowerQuestion.match(/(?:who|which\s+students?)\s+(?:is|are)\s+not\s+(?:assigned|mentored)/i)) {
    console.log(`🎯 [Cross-Query] Students with no mentor`);

    return {
      collection: "students",
      operation: "find",
      query: { "$or": [{ "mentorEmail": null }, { "mentorEmail": { "$exists": false } }], "isActive": true },
      projection: { name: 1, studentID: 1, stream: 1, semester: 1, _id: 0 },
      explanation: `Students who have not been assigned to a mentor yet`
    };
  }

  // =========== CROSS-QUERY 13: COUNT QUERIES ===========
  if (lowerQuestion.match(/how\s+many\s+students?|total\s+students?|count\s+students?/i)) {
    console.log(`🎯 [Cross-Query] Student count`);

    const query = { isActive: true };
    if (detectedStream) query.stream = { $regex: `^${detectedStream}$`, $options: 'i' };
    if (detectedSemester) query.semester = detectedSemester;

    return {
      collection: "students",
      operation: "countDocuments",
      query: query,
      explanation: `Total students${detectedStream ? ` in ${detectedStream}` : ''}${detectedSemester ? ` Sem ${detectedSemester}` : ''}`
    };
  }

  if (lowerQuestion.match(/how\s+many\s+teachers?|total\s+teachers?|count\s+teachers?/i)) {
    console.log(`🎯 [Cross-Query] Teacher count`);

    return {
      collection: "teachers",
      operation: "countDocuments",
      query: {},
      explanation: `Total teachers`
    };
  }

  if (lowerQuestion.match(/how\s+many\s+subjects?|total\s+subjects?|count\s+subjects?/i)) {
    console.log(`🎯 [Cross-Query] Subject count`);

    const query = { isActive: true };
    if (detectedStream) query.stream = { $regex: `^${detectedStream}$`, $options: 'i' };
    if (detectedSemester) query.semester = detectedSemester;

    return {
      collection: "subjects",
      operation: "countDocuments",
      query: query,
      explanation: `Total subjects${detectedStream ? ` in ${detectedStream}` : ''}${detectedSemester ? ` Sem ${detectedSemester}` : ''}`
    };
  }

  // =========== PRE-BUILT TEMPLATE: LIST STUDENTS BY STREAM/SEMESTER ===========
  // Catch patterns like: "list students from BDA sem 6", "show all BCA students", "students in BBA semester 3"
  if (lowerQuestion.match(/(?:list|show|get|all|find)\s*(?:all\s*)?(?:the\s*)?students?|students?\s+(?:from|in|of)/i)) {
    console.log(`🎯 [Quick Match] Student list query detected`);

    const studentQuery = { isActive: true };
    if (detectedStream) studentQuery.stream = { $regex: `^${detectedStream}$`, $options: 'i' };
    if (detectedSemester) studentQuery.semester = detectedSemester;

    console.log(`📍 Student Query - Stream: ${detectedStream || 'ALL'}, Semester: ${detectedSemester || 'ALL'}`);

    return {
      collection: "students",
      operation: "find",
      query: studentQuery,
      explanation: `Students${detectedStream ? ` in ${detectedStream}` : ''}${detectedSemester ? ` Semester ${detectedSemester}` : ''}`
    };
  }

  // =========== PRE-BUILT TEMPLATE: LOW ATTENDANCE / DEFAULTERS ===========
  if (lowerQuestion.match(/low\s*attendance|below\s*75|less\s*than\s*75|defaulter|shortage|poor\s*attendance|<\s*75/i)) {
    console.log(`🎯 [Quick Match] Low attendance query detected`);
    console.log(`📍 Detected Stream: ${detectedStream || 'ALL'}, Semester: ${detectedSemester || 'ALL'}`);

    const matchFilter = { isActive: true };
    if (detectedStream) matchFilter.stream = { $regex: `^${detectedStream}$`, $options: 'i' };
    if (detectedSemester) matchFilter.semester = detectedSemester;

    return {
      collection: "students",
      operation: "aggregate",
      query: [
        { "$match": matchFilter },
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
                  "_id": null,
                  "totalClasses": { "$sum": 1 },
                  "attended": { "$sum": { "$cond": [{ "$in": ["$$studentID", "$studentsPresent"] }, 1, 0] } }
                }
              }
            ],
            "as": "stats"
          }
        },
        { "$unwind": { "path": "$stats", "preserveNullAndEmptyArrays": true } },
        {
          "$addFields": {
            "attendancePercentage": {
              "$cond": [
                { "$gt": [{ "$ifNull": ["$stats.totalClasses", 0] }, 0] },
                { "$multiply": [{ "$divide": ["$stats.attended", "$stats.totalClasses"] }, 100] },
                0
              ]
            }
          }
        },
        { "$match": { "attendancePercentage": { "$lt": 75 } } },
        {
          "$project": {
            "name": 1, "studentID": 1, "stream": 1, "semester": 1,
            "attendancePercentage": { "$round": ["$attendancePercentage", 1] },
            "classesAttended": "$stats.attended",
            "totalClasses": "$stats.totalClasses"
          }
        },
        { "$sort": { "attendancePercentage": 1 } }
      ],
      explanation: `Students with attendance below 75%${detectedStream ? ` in ${detectedStream}` : ''}${detectedSemester ? ` Semester ${detectedSemester}` : ''}`
    };
  }

  // =========== PRE-BUILT TEMPLATE: DATE-BASED ATTENDANCE ===========
  if (parsedDate || lowerQuestion.includes('today') || lowerQuestion.includes('yesterday')) {
    const dateToUse = parsedDate || (lowerQuestion.includes('yesterday')
      ? new Date(Date.now() - 86400000).toISOString().split('T')[0]
      : currentDate);

    if (lowerQuestion.match(/attendance|class|session/i)) {
      console.log(`🎯 [Quick Match] Date-based attendance: ${dateToUse}`);

      // Extract stream and semester for filtering
      const streamPatterns = lowerQuestion.match(/\b([a-z]{2,5})\b/gi) || [];
      const knownStreams = ['bca', 'bba', 'bcom', 'mca', 'mba', 'bda', 'bsc', 'ba', 'btech', 'mtech', 'msc', 'ma'];
      let detectedStream = null;
      for (const word of streamPatterns) {
        if (knownStreams.includes(word.toLowerCase())) {
          detectedStream = word.toUpperCase();
          break;
        }
      }

      let detectedSemester = null;
      const semPatterns = [/sem(?:ester)?\s*(\d)/i, /(\d)(?:st|nd|rd|th)?\s*sem/i, /\bsem(\d)\b/i];
      for (const pattern of semPatterns) {
        const match = lowerQuestion.match(pattern);
        if (match) { detectedSemester = parseInt(match[1]); break; }
      }

      const query = { "date": { "$regex": `^${dateToUse}` } };
      if (detectedStream) query.stream = detectedStream;
      if (detectedSemester) query.semester = detectedSemester;

      return {
        collection: "attendance",
        operation: "find",
        query: query,
        projection: { "subject": 1, "stream": 1, "semester": 1, "teacherName": 1, "presentCount": 1, "absentCount": 1, "totalStudents": 1, "time": 1, "date": 1 },
        explanation: `Attendance records for ${dateToUse}${detectedStream ? ` in ${detectedStream}` : ''}${detectedSemester ? ` Semester ${detectedSemester}` : ''}`
      };
    }
  }

  // =========== PRE-BUILT TEMPLATE: STUDENT ATTENDANCE REPORT ===========
  // Catch patterns like: "attendance of X", "report for X", "Arvind's attendance", 
  // "how many classes has Arvind attended", "classes attended by Arvind", "pruthvi m u attendance"
  const studentAttendanceRegex = /(?:attendance|report|how\s+many\s+classes|classes(?:\s+attended)?).*?(?:of|for|by|student|has)\s+([^?.]+)|([^?.]+?)(?:'s?\s+|\s+)(?:attendance|report|classes)(?:\s+report)?/i;
  const attendanceMatch = lowerQuestion.match(studentAttendanceRegex);

  // Words that indicate it's NOT a student name (generic queries like "show attendance", "today attendance")
  const skipAttendanceNames = ['show', 'get', 'list', 'find', 'display', 'view', 'give', 'today', 'todays',
    'all', 'total', 'overall', 'class', 'daily', 'monthly', 'weekly', 'bca', 'bba', 'bcom', 'bda', 'mca',
    'mba', 'the', 'my', 'our', 'sem', 'semester'];

  if (attendanceMatch) {
    let studentName = (attendanceMatch[1] || attendanceMatch[2]).trim();
    // Clean up suffix "attended" if it was captured
    studentName = studentName.replace(/\s+attended$/i, '').trim();
    // Remove possessive
    studentName = studentName.replace(/'s?$/i, '').trim();
    // Remove common filler words that might be captured at the start
    studentName = studentName.replace(/^(?:student|has|attended)\s+/i, '').trim();

    const firstWord = studentName.split(' ')[0].toLowerCase();
    if (studentName && studentName.length > 2 && !skipAttendanceNames.includes(firstWord) &&
        !studentName.match(/^(?:bca|bba|bcom|bda|mca|mba)\b/i) &&
        !studentName.match(/^\d/) && !studentName.match(/^sem/i)) {
      console.log(`🎯 [Quick Match] Student attendance query for: ${studentName}`);
      return buildStudentAttendanceQuery(studentName, parsedDate);
    }
  }

  // =========== PRE-BUILT TEMPLATE: SUBJECT LISTS ===========
  if (lowerQuestion.match(/subjects|curriculum|syllabus|papers|classes\s+of/i)) {
    console.log(`🎯 [Quick Match] Subject list query detected`);

    // Extract stream
    const streamPatterns = lowerQuestion.match(/\b([a-z]{2,5})\b/gi) || [];
    const knownStreams = ['bca', 'bba', 'bcom', 'mca', 'mba', 'bda', 'bsc', 'ba', 'btech', 'mtech', 'msc', 'ma'];
    let detectedStream = null;
    for (const word of streamPatterns) {
      if (knownStreams.includes(word.toLowerCase())) {
        detectedStream = word.toUpperCase();
        break;
      }
    }

    // Extract semester
    let detectedSemester = null;
    const semPatterns = [/sem(?:ester)?\s*(\d)/i, /(\d)(?:st|nd|rd|th)?\s*sem/i, /\bsem(\d)\b/i];
    for (const pattern of semPatterns) {
      const match = lowerQuestion.match(pattern);
      if (match) { detectedSemester = parseInt(match[1]); break; }
    }

    const query = { isActive: true };
    if (detectedStream) query.stream = detectedStream;
    if (detectedSemester) query.semester = detectedSemester;

    return {
      collection: "subjects",
      operation: "find",
      query: query,
      projection: { name: 1, subjectCode: 1, stream: 1, semester: 1, subjectType: 1 },
      explanation: `Subject list for ${detectedStream || 'all streams'}${detectedSemester ? ` Semester ${detectedSemester}` : ''}`
    };
  }

  // =========== PRE-BUILT TEMPLATE: ATTENDANCE SUMMARY ===========
  if (lowerQuestion.match(/attendance\s+summary|overall\s+attendance|attendance\s+overview|attendance\s+stats/i)) {
    console.log(`🎯 [Quick Match] Attendance summary query detected`);

    // Extract stream
    const streamPatterns = lowerQuestion.match(/\b([a-z]{2,5})\b/gi) || [];
    const knownStreams = ['bca', 'bba', 'bcom', 'mca', 'mba', 'bda', 'bsc', 'ba', 'btech', 'mtech', 'msc', 'ma'];
    let detectedStream = null;
    for (const word of streamPatterns) {
      if (knownStreams.includes(word.toLowerCase())) {
        detectedStream = word.toUpperCase();
        break;
      }
    }

    // Extract semester
    let detectedSemester = null;
    const semPatterns = [/sem(?:ester)?\s*(\d)/i, /(\d)(?:st|nd|rd|th)?\s*sem/i, /\bsem(\d)\b/i];
    for (const pattern of semPatterns) {
      const match = lowerQuestion.match(pattern);
      if (match) { detectedSemester = parseInt(match[1]); break; }
    }

    // If both stream and semester are detected, show STUDENT + SUBJECT summary
    if (detectedStream && detectedSemester) {
      console.log(`🎯 [Template Override] Student+Subject summary for ${detectedStream} Sem ${detectedSemester}`);
      return {
        collection: "students",
        operation: "aggregate",
        query: [
          { "$match": { "stream": detectedStream, "semester": detectedSemester, "isActive": true } },
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
                }
              ],
              "as": "subjectStats"
            }
          },
          { "$unwind": { "path": "$subjectStats", "preserveNullAndEmptyArrays": false } },
          {
            "$addFields": {
              "attendancePercentage": {
                "$cond": [
                  { "$gt": ["$subjectStats.totalClasses", 0] },
                  { "$multiply": [{ "$divide": ["$subjectStats.attended", "$subjectStats.totalClasses"] }, 100] },
                  0
                ]
              }
            }
          },
          {
            "$project": {
              "name": 1,
              "studentID": 1,
              "subject": "$subjectStats._id",
              "attendancePercentage": { "$round": ["$attendancePercentage", 1] },
              "classesAttended": "$subjectStats.attended",
              "totalClasses": "$subjectStats.totalClasses",
              "stream": 1,
              "semester": 1
            }
          },
          { "$sort": { "studentID": 1, "subject": 1 } }
        ],
        explanation: `Detailed student-wise and subject-wise attendance summary for ${detectedStream} Semester ${detectedSemester}`
      };
    }

    const matchStage = {};
    if (detectedStream) matchStage.stream = detectedStream;
    if (detectedSemester) matchStage.semester = detectedSemester;

    return {
      collection: "attendance",
      operation: "aggregate",
      query: [
        { "$match": matchStage },
        {
          "$group": {
            "_id": detectedSemester ? "$subject" : "$semester",
            "totalSessions": { "$sum": 1 },
            "totalPresent": { "$sum": "$presentCount" },
            "totalStudents": { "$sum": "$totalStudents" }
          }
        },
        {
          "$addFields": {
            "avgPercentage": {
              "$cond": [
                { "$gt": ["$totalStudents", 0] },
                { "$round": [{ "$multiply": [{ "$divide": ["$totalPresent", "$totalStudents"] }, 100] }, 1] },
                0
              ]
            }
          }
        },
        { "$sort": { "_id": 1 } }
      ],
      explanation: `${detectedStream || ''} Attendance Summary${detectedSemester ? ` for Semester ${detectedSemester}` : ''}`
    };
  }

  const dateHint = parsedDate ? `\n\nDETECTED DATE: ${parsedDate} (use this exact format in queries)` : '';

  // Simplified prompt for faster response
  const prompt = `${schemaContext}

CURRENT DATE: ${currentDate}
CURRENT DATE TIME (UTC): ${currentDateTime}
CURRENT USER: Itzzsk

USER QUESTION: "${question}"${dateHint}

==============================================================================
SCHEMA REFERENCE:
==============================================================================

**STUDENTS:** studentID, name, stream, semester, mentorEmail, parentPhone, languageSubject, electiveSubject, academicYear, isActive
**TEACHERS:** name, email, phone, department, createdSubjects[{subject, stream, semester, subjectCode}], mentees[{name, studentID, stream, semester}]
**SUBJECTS:** name, subjectCode, stream, semester, subjectType (CORE/ELECTIVE), teacherAssigned
**ATTENDANCE:** stream, semester, subject, date (ISO: "YYYY-MM-DDTHH:MM:SS.000Z"), time, studentsPresent[], totalStudents, presentCount, absentCount

==============================================================================
QUERY RULES (SIMPLIFIED):
==============================================================================

1. **Students:** Always include "isActive": true
2. **Text Search:** { "$regex": "text", "$options": "i" }
3. **Date Queries:** { "date": { "$regex": "^YYYY-MM-DD" } } - NO $date operator
4. **Counts:** Use countDocuments
5. **Teachers:** Search createdSubjects.subject for "who teaches"
6. Generate COMPACT queries (avoid overly complex aggregations)

==============================================================================
QUICK EXAMPLES:
==============================================================================

**List Students:**
{"collection":"students","operation":"find","query":{"isActive":true},"explanation":"All students"}

**BCA Sem 5:**
{"collection":"students","operation":"find","query":{"stream":"BCA","semester":5,"isActive":true},"explanation":"BCA Semester 5"}

**Find Teacher:**
{"collection":"teachers","operation":"find","query":{"name":{"$regex":"Smith","$options":"i"}},"explanation":"Teacher Smith"}

**Today Attendance:**
{"collection":"attendance","operation":"find","query":{"date":{"$regex":"^${currentDate}"}},"explanation":"Today's attendance"}

**Date Attendance:**
{"collection":"attendance","operation":"find","query":{"date":{"$regex":"^2025-10-15"}},"explanation":"Oct 15 attendance"}

**Count Students:**
{"collection":"students","operation":"countDocuments","query":{"stream":"BCA","isActive":true},"explanation":"Total BCA students"}

==============================================================================
IMPORTANT:
==============================================================================

- Generate ONLY valid JSON (no markdown, no code blocks)
- Start with { and end with }
- Keep queries COMPACT and SIMPLE
- NO emojis in explanation
- NO $date operator (use $regex for dates)

Generate JSON query:`;

  try {
    const response = await geminiService.generateResponse(prompt);
    console.log(`📦 [Gemini] Response Length: ${response.length} chars`);

    // Robust JSON extraction
    let cleaned = response
      .replace(/```json/gi, '')
      .replace(/```\s*/g, '')
      .replace(/^[^{]*/, '')
      .replace(/[^}]*$/, '')
      .trim();

    // Find complete JSON object
    let depth = 0;
    let startIdx = -1;
    let endIdx = -1;

    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === '{') {
        if (depth === 0) startIdx = i;
        depth++;
      } else if (cleaned[i] === '}') {
        depth--;
        if (depth === 0 && startIdx !== -1) {
          endIdx = i;
          break;
        }
      }
    }

    let jsonMatch = null;
    if (startIdx !== -1 && endIdx !== -1) {
      jsonMatch = cleaned.substring(startIdx, endIdx + 1);
    } else {
      // Fallback regex
      const regexMatch = cleaned.match(/\{[\s\S]*\}/);
      if (regexMatch) jsonMatch = regexMatch[0];
    }

    if (!jsonMatch) {
      console.error('❌ No valid JSON found');
      throw new Error('No valid JSON found in response');
    }

    let parsedQuery;
    try {
      parsedQuery = JSON.parse(jsonMatch);
    } catch (parseError) {
      console.error('❌ JSON Parse Error:', parseError.message);
      // Try to fix trailing commas
      try {
        let fixed = jsonMatch.replace(/,(\s*[}\]])/g, '$1');
        parsedQuery = JSON.parse(fixed);
        console.log('✅ Fixed JSON by removing trailing commas');
      } catch (fixError) {
        throw new Error(`Invalid JSON format: ${parseError.message}`);
      }
    }

    // Validate required fields
    if (!parsedQuery.collection || !parsedQuery.operation) {
      if (parsedQuery.collection !== null) {
        throw new Error('Query missing required fields');
      }
    }

    console.log(`✅ [Parsed Query]:
   Collection: ${parsedQuery.collection}
   Operation: ${parsedQuery.operation}
   Explanation: ${parsedQuery.explanation}`);

    return parsedQuery;

  } catch (error) {
    console.error(`❌ [Query Generation Failed]:`, error.message);
    throw new Error(`Failed to generate query: ${error.message}`);
  }
}


// ============================================================================
// GENERATE ACCURATE NATURAL INTRO - CONTEXT-AWARE
// ============================================================================

function generateNaturalIntro(question, results, collection) {
  const count = Array.isArray(results) ? results.length : (typeof results === 'number' ? results : 1);

  // For students
  if (collection === 'students') {
    if (count === 0) {
      return "I couldn't find any students matching your search criteria. The student might not be registered in the system, or there could be a spelling error in the name.";
    } else if (count === 1) {
      const student = results[0];
      const streamInfo = student.stream && student.semester ? ` They are currently enrolled in ${student.stream} Semester ${student.semester}` : '';
      const yearInfo = student.academicYear ? ` (${student.academicYear})` : '';
      return `I found the student record for ${student.name || 'this student'}.${streamInfo}${yearInfo}. Here are their complete details:`;
    } else {
      const streams = [...new Set(results.map(s => s.stream))];
      const streamText = streams.length === 1 ? streams[0] : `${streams.length} different streams`;
      return `I found ${count} students in the database${streams.length > 0 ? ` across ${streamText}` : ''}. Here's the complete list with all their information:`;
    }
  }

  // For teachers
  if (collection === 'teachers') {
    if (count === 0) {
      return "I couldn't find any teachers matching your search. Please verify the name spelling or try searching with partial names.";
    } else if (count === 1) {
      const teacher = results[0];
      const subjectCount = teacher.createdSubjects?.length || 0;
      return `I found ${teacher.name}'s profile in the system. They are currently teaching ${subjectCount} subject${subjectCount !== 1 ? 's' : ''}${teacher.department ? ` in the ${teacher.department} department` : ''}. Here's their complete information:`;
    } else {
      const totalSubjects = results.reduce((sum, t) => sum + (t.createdSubjects?.length || 0), 0);
      return `I found ${count} teachers in the faculty database, collectively teaching ${totalSubjects} subjects across various streams. Here's detailed information about each:`;
    }
  }

  // For subjects
  if (collection === 'subjects') {
    if (count === 0) {
      return "I couldn't find any subjects matching your search criteria. Please check the stream name, semester number, or subject type.";
    } else {
      const cores = results.filter(s => s.subjectType === 'CORE').length;
      const electives = results.filter(s => s.subjectType === 'ELECTIVE').length;
      return `I found ${count} subject${count !== 1 ? 's' : ''} in the curriculum${cores > 0 && electives > 0 ? ` (${cores} core and ${electives} elective)` : ''}. Here's the complete breakdown:`;
    }
  }

  // For attendance records
  if (collection === 'attendance') {
    if (count === 0) {
      return "I couldn't find any attendance records matching your criteria. Classes might not have been conducted yet for the specified date or criteria.";
    } else {
      const totalPresent = results.reduce((sum, r) => sum + (r.presentCount || 0), 0);
      const totalStudents = results.reduce((sum, r) => sum + (r.totalStudents || 0), 0);
      const avgPct = totalStudents > 0 ? ((totalPresent / totalStudents) * 100).toFixed(1) : '0';
      return `I found ${count} attendance session${count !== 1 ? 's' : ''} on record with an average attendance of ${avgPct}%. Here's the detailed breakdown:`;
    }
  }

  // For counts
  if (typeof results === 'number') {
    return `I've counted the total number of ${collection} in the database. The count is ${results}. Here's the summary:`;
  }

  // Default
  return `I retrieved ${count} record${count !== 1 ? 's' : ''} matching your query. Here are the details:`;
}


// ============================================================================
// FORMAT AS TABLE - WITH ACCURATE NATURAL INTRO
// ============================================================================

function formatAsTable(results, collection, question) {
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  // Bypass table formatting for specific record queries handled in generateNaturalResponse
  const lowerQuestion = question.toLowerCase();
  const isMentorQuery = lowerQuestion.includes('mentor for') ||
    lowerQuestion.includes('who is the mentor') ||
    lowerQuestion.includes('which teacher mentors');

  if (isMentorQuery) {
    return null;
  }

  // Get natural intro
  const intro = generateNaturalIntro(question, results, collection);
  let table = `${intro}\n\n`;

  const firstItem = results[0];

  // =========== ABSENT STUDENTS TABLE (with missedSubjects) ===========
  if (firstItem.missedSubjects && Array.isArray(firstItem.missedSubjects)) {
    table += `| # | Student ID | Name | Stream | Sem | Missed Subjects | Missed Count |\n`;
    table += `|---|------------|------|--------|-----|-----------------|-------------|\n`;

    results.slice(0, 100).forEach((student, index) => {
      const id = (student.studentID || '-').substring(0, 14);
      const name = (student.name || '-').substring(0, 18);
      const stream = student.stream || '-';
      const sem = student.semester || '-';
      const subjects = student.missedSubjects.join(', ').substring(0, 50) || '-';
      const count = student.missedCount || student.missedSubjects.length || 0;

      table += `| ${index + 1} | ${id} | ${name} | ${stream} | ${sem} | ${subjects} | ${count} |\n`;
    });

    if (results.length > 100) {
      table += `\n*+${results.length - 100} more students*\n`;
    }

    const totalMissed = results.reduce((sum, s) => sum + (s.missedCount || 0), 0);
    table += `\n### Summary\n\n`;
    table += `| Metric | Value |\n`;
    table += `|--------|-------|\n`;
    table += `| Students Absent | ${results.length} |\n`;
    table += `| Total Classes Missed | ${totalMissed} |\n`;

    return table;
  }

  // =========== PRESENT STUDENTS TABLE (with attendedSubjects) ===========
  if (firstItem.attendedSubjects && Array.isArray(firstItem.attendedSubjects)) {
    table += `| # | Student ID | Name | Stream | Sem | Attended Subjects | Attended Count |\n`;
    table += `|---|------------|------|--------|-----|-------------------|---------------|\n`;

    results.slice(0, 100).forEach((student, index) => {
      const id = (student.studentID || '-').substring(0, 14);
      const name = (student.name || '-').substring(0, 18);
      const stream = student.stream || '-';
      const sem = student.semester || '-';
      const subjects = student.attendedSubjects.join(', ').substring(0, 50) || '-';
      const count = student.attendedCount || student.attendedSubjects.length || 0;

      table += `| ${index + 1} | ${id} | ${name} | ${stream} | ${sem} | ${subjects} | ${count} |\n`;
    });

    if (results.length > 100) {
      table += `\n*+${results.length - 100} more students*\n`;
    }

    const totalAttended = results.reduce((sum, s) => sum + (s.attendedCount || 0), 0);
    table += `\n### Summary\n\n`;
    table += `| Metric | Value |\n`;
    table += `|--------|-------|\n`;
    table += `| Students Present | ${results.length} |\n`;
    table += `| Total Classes Attended | ${totalAttended} |\n`;

    return table;
  }

  // =========== STUDENT + SUBJECT DETAILED SUMMARY TABLE ===========
  if (firstItem.studentID && firstItem.subject && firstItem.attendancePercentage !== undefined) {
    table = `Detailed attendance summary for ${firstItem.stream || ''} Semester ${firstItem.semester || ''}, sorted by Student ID:\n\n`;
    table += `| # | Student ID | Name | Subject | Attended | Total | Att % | Status |\n`;
    table += `|---|------------|------|---------|----------|-------|-------|--------|\n`;

    results.forEach((row, index) => {
      const id = (row.studentID || '-').substring(0, 14);
      const name = (row.name || '-').substring(0, 20);
      const subject = (row.subject || '-').substring(0, 25);
      const attended = row.classesAttended !== undefined ? row.classesAttended : 0;
      const total = row.totalClasses !== undefined ? row.totalClasses : 0;
      const pct = row.attendancePercentage !== undefined ? row.attendancePercentage.toFixed(1) : '0';
      const status = parseFloat(pct) >= 75 ? '✓ Good' : '⚠ Low';

      table += `| ${index + 1} | ${id} | ${name} | ${subject} | ${attended} | ${total} | ${pct}% | ${status} |\n`;
    });

    return table;
  }

  // =========== LOW ATTENDANCE / DEFAULTERS TABLE ===========
  if (firstItem.attendancePercentage !== undefined && firstItem.studentID) {
    table = `I found ${results.length} student${results.length !== 1 ? 's' : ''} with attendance below 75%. Here's the complete list sorted by attendance percentage:\n\n`;
    table += `| # | Student ID | Name | Stream | Sem | Attendance % | Classes | Status |\n`;
    table += `|---|------------|------|--------|-----|--------------|---------|--------|\n`;

    results.slice(0, 100).forEach((student, index) => {
      const id = (student.studentID || '-').substring(0, 14);
      const name = (student.name || '-').substring(0, 20);
      const stream = student.stream || '-';
      const sem = student.semester || '-';
      const pct = student.attendancePercentage !== undefined ? student.attendancePercentage.toFixed(1) : '0';
      const classes = student.classesAttended !== undefined && student.totalClasses !== undefined
        ? `${student.classesAttended}/${student.totalClasses}`
        : '-';
      const status = parseFloat(pct) < 50 ? '⚠ Critical' : '⚠ Low';

      table += `| ${index + 1} | ${id} | ${name} | ${stream} | ${sem} | ${pct}% | ${classes} | ${status} |\n`;
    });

    if (results.length > 100) {
      table += `\n*+${results.length - 100} more students*\n`;
    }

    const critical = results.filter(s => s.attendancePercentage < 50).length;
    const low = results.filter(s => s.attendancePercentage >= 50 && s.attendancePercentage < 75).length;

    table += `\n### Summary\n\n`;
    table += `| Metric | Count |\n`;
    table += `|--------|:-----:|\n`;
    table += `| Total Defaulters | ${results.length} |\n`;
    table += `| Critical (Below 50%) | ${critical} |\n`;
    table += `| Low (50% - 74%) | ${low} |\n`;

    return table;
  }

  // Student table (regular)
  if (collection === 'students' || (firstItem.studentID && firstItem.name && !firstItem.email)) {
    table += `| # | ID | Name | Stream | Sem | Mentor | Phone |\n`;
    table += `|---|----|----|--------|-----|--------|-------|\n`;

    results.slice(0, 100).forEach((student, index) => {
      const id = (student.studentID || 'N/A').substring(0, 12);
      const name = (student.name || 'N/A').substring(0, 18);
      const stream = student.stream || 'N/A';
      const sem = student.semester != null ? student.semester : 'N/A';
      const phone = (student.parentPhone && student.parentPhone.trim() !== '') ? student.parentPhone : 'N/A';
      const mentor = student.mentorName || (student.mentorEmail ? student.mentorEmail.split('@')[0] : 'Not Assigned');

      table += `| ${index + 1} | ${id} | ${name} | ${stream} | ${sem} | ${mentor} | ${phone} |\n`;
    });

    if (results.length > 100) {
      table += `\n*+${results.length - 100} more students*\n`;
    }

    // Accurate summary
    const streamCounts = {};
    results.forEach(s => {
      const stream = s.stream || 'Unknown';
      streamCounts[stream] = (streamCounts[stream] || 0) + 1;
    });

    table += `\n### Summary\n\n`;
    table += `| Metric | Value |\n`;
    table += `|--------|-------|\n`;
    table += `| Total Students | ${results.length} |\n`;
    Object.entries(streamCounts).forEach(([stream, count]) => {
      table += `| ${stream} | ${count} |\n`;
    });

    return table;
  }

  // Subject table
  if (collection === 'subjects' || (firstItem.name && firstItem.subjectCode)) {
    table += `| # | Subject | Code | Stream | Sem | Type |\n`;
    table += `|---|---------|------|--------|-----|------|\n`;

    results.slice(0, 100).forEach((subject, index) => {
      const name = (subject.name || '-').substring(0, 25);
      const code = (subject.subjectCode || '-').substring(0, 10);
      const stream = subject.stream || '-';
      const sem = subject.semester || '-';
      const type = subject.subjectType === 'CORE' ? 'Core' : subject.subjectType === 'ELECTIVE' ? 'Elec' : '-';

      table += `| ${index + 1} | ${name} | ${code} | ${stream} | ${sem} | ${type} |\n`;
    });

    if (results.length > 100) {
      table += `\n*+${results.length - 100} more subjects*\n`;
    }

    const typeCounts = { CORE: 0, ELECTIVE: 0 };
    results.forEach(s => {
      if (s.subjectType === 'CORE') typeCounts.CORE++;
      else if (s.subjectType === 'ELECTIVE') typeCounts.ELECTIVE++;
    });

    table += `\n### Summary\n\n`;
    table += `| Metric | Count |\n`;
    table += `|--------|:-----:|\n`;
    table += `| Total Subjects | ${results.length} |\n`;
    table += `| Core | ${typeCounts.CORE} |\n`;
    table += `| Elective | ${typeCounts.ELECTIVE} |\n`;

    return table;
  }

  // Attendance table
  if (collection === 'attendance' || (firstItem.subject && firstItem.date)) {
    // =========== ATTENDANCE SUMMARY TABLE (STATS OVERVIEW) ===========
    if (firstItem.avgPercentage !== undefined && firstItem.totalSessions !== undefined) {
      const isSemBreakdown = typeof firstItem._id === 'number';
      table = `### Attendance Overview\n\n`;
      table += `| # | ${isSemBreakdown ? 'Semester' : 'Subject'} | Sessions | Present | Students | Avg Att% | Status |\n`;
      table += `|---|----------|----------|---------|----------|----------|--------|\n`;

      results.forEach((stat, index) => {
        const label = stat._id || '-';
        const sessions = stat.totalSessions || 0;
        const present = stat.totalPresent || 0;
        const total = stat.totalStudents || 0;
        const pct = stat.avgPercentage !== undefined ? stat.avgPercentage.toFixed(1) : '0';
        const status = parseFloat(pct) >= 75 ? '✓ Good' : '⚠ Low';

        table += `| ${index + 1} | ${label} | ${sessions} | ${present} | ${total} | ${pct}% | ${status} |\n`;
      });

      const grandTotalPresent = results.reduce((sum, r) => sum + (r.totalPresent || 0), 0);
      const grandTotalStudents = results.reduce((sum, r) => sum + (r.totalStudents || 0), 0);
      const grandTotalSessions = results.reduce((sum, r) => sum + (r.totalSessions || 0), 0);
      const weightedAvg = grandTotalStudents > 0 ? ((grandTotalPresent / grandTotalStudents) * 100).toFixed(1) : '0';

      table += `\n### Overall\n\n`;
      table += `| Metric | Value |\n`;
      table += `|--------|-------|\n`;
      table += `| Total Sessions | ${grandTotalSessions} |\n`;
      table += `| Overall Presence | ${grandTotalPresent} / ${grandTotalStudents} |\n`;
      table += `| Average Attendance | ${weightedAvg}% |\n`;

      return table;
    }

    // Regular attendance records table
    table += `| # | Subject | Stream | Sem | Date | Present | Absent | Att% |\n`;
    table += `|---|---------|--------|-----|------|---------|--------|------|\n`;

    results.slice(0, 100).forEach((att, index) => {
      const subject = (att.subject || '-').substring(0, 22);
      const stream = att.stream || '-';
      const sem = att.semester || '-';
      const date = att.date ? new Date(att.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-';
      const present = att.presentCount !== undefined ? att.presentCount : '-';
      const absent = att.absentCount !== undefined ? att.absentCount : (att.totalStudents - att.presentCount || '-');
      const pct = att.totalStudents > 0 ? ((att.presentCount / att.totalStudents) * 100).toFixed(1) : '0';

      table += `| ${index + 1} | ${subject} | ${stream} | ${sem} | ${date} | ${present} | ${absent} | ${pct}% |\n`;
    });

    if (results.length > 100) {
      table += `\n*+${results.length - 100} more records*\n`;
    }

    const totalPresent = results.reduce((sum, r) => sum + (r.presentCount || 0), 0);
    const totalStudents = results.reduce((sum, r) => sum + (r.totalStudents || 0), 0);
    const avgPct = totalStudents > 0 ? ((totalPresent / totalStudents) * 100).toFixed(1) : '0';

    table += `\n### Summary\n\n`;
    table += `| Metric | Value |\n`;
    table += `|--------|-------|\n`;
    table += `| Total Sessions | ${results.length} |\n`;
    table += `| Average Attendance | ${avgPct}% |\n`;
    table += `| Total Present | ${totalPresent} / ${totalStudents} |\n`;

    return table;
  }

  // =========== TEACHERS TABLE ===========
  if (collection === 'teachers' || (firstItem.email && !firstItem.studentID && !firstItem.subject)) {
    // Detailed Profile View for a single teacher (Subjects in Table format)
    if (results.length === 1) {
      const teacher = results[0];
      table = `### Teacher Profile: ${teacher.name || teacher.displayName || 'Teacher'}\n`;
      table += `**Contact Email:** ${teacher.email || '-'}\n\n`;

      if (teacher.createdSubjects && Array.isArray(teacher.createdSubjects) && teacher.createdSubjects.length > 0) {
        table += `#### Assigned Subjects\n`;
        table += `| # | Subject Name | Stream | Semester |\n`;
        table += `|---|--------------|--------|----------|\n`;

        teacher.createdSubjects.forEach((sub, idx) => {
          table += `| ${idx + 1} | ${sub.subject || '-'} | ${sub.stream || '-'} | ${sub.semester || '-'} |\n`;
        });
        table += `\n**Summary:** ${teacher.createdSubjects.length} subjects total\n\n`;
      } else {
        table += `*No subjects found for this teacher.*\n\n`;
      }

      // Add Assigned Mentees section
      if (teacher.mentees && Array.isArray(teacher.mentees) && teacher.mentees.length > 0) {
        table += `#### Assigned Mentees (Mentorship)\n`;
        table += `| # | Student ID | Name | Stream | Sem |\n`;
        table += `|---|------------|------|--------|-----|\n`;

        teacher.mentees.forEach((mentee, idx) => {
          table += `| ${idx + 1} | ${mentee.studentID || '-'} | ${mentee.name || '-'} | ${mentee.stream || '-'} | ${mentee.semester || '-'} |\n`;
        });
        table += `\n**Total Mentees:** ${teacher.mentees.length}`;
      } else {
        table += `*No students assigned for mentorship.*`;
      }

      return table;
    }

    // List view for multiple teachers — clean and simple
    table += `| # | Name | Email | No. of Subjects |\n`;
    table += `|---|------|-------|-----------------|\n`;

    results.slice(0, 100).forEach((teacher, index) => {
      const name = (teacher.name || teacher.displayName || '-').substring(0, 25);
      const email = (teacher.email || '-').substring(0, 35);
      const subCount = (teacher.createdSubjects && Array.isArray(teacher.createdSubjects))
        ? teacher.createdSubjects.length : 0;

      table += `| ${index + 1} | ${name} | ${email} | ${subCount} |\n`;
    });

    if (results.length > 100) {
      table += `\n*+${results.length - 100} more teachers*\n`;
    }

    table += `\n### Summary\n\n`;
    table += `| Metric | Value |\n`;
    table += `|--------|-------|\n`;
    table += `| Total Teachers | ${results.length} |\n`;

    return table;
  }

  return table;
}


// ============================================================================
// GENERATE FINAL NATURAL RESPONSE - ACCURATE WITH INTRO
// ============================================================================

async function generateNaturalResponse(question, results, queryInfo) {
  console.log(`📝 [Natural Response] Processing...`);

  // Handle greetings or null collection
  if (!queryInfo.collection || queryInfo.collection === null) {
    return queryInfo.explanation || "Hello! I'm here to help you with student records, attendance tracking, subject information, and teacher profiles. What would you like to know?";
  }

  // For count operations - add accurate natural intro
  if (queryInfo.operation === 'countDocuments') {
    const intro = generateNaturalIntro(question, results, queryInfo.collection);
    return `${intro}\n\n## Total Count: **${results}**\n\nThis represents the total number of ${queryInfo.collection} records matching your search criteria in the database.`;
  }

  // Check if this is a "who teaches X" type query - give simple answer
  const lowerQuestion = question.toLowerCase();
  const isWhoTeachesQuery = lowerQuestion.includes('who teaches') ||
    lowerQuestion.includes('who is teaching') ||
    lowerQuestion.includes('teacher of') ||
    lowerQuestion.includes('teaches this');

  if (queryInfo.collection === 'teachers' && isWhoTeachesQuery && Array.isArray(results)) {
    console.log(`👨‍🏫 Detected "who teaches" query - returning simple response`);

    if (results.length === 0) {
      return "I couldn't find any teacher assigned to that subject. The subject might not be in the system yet.";
    }

    // Extract subject name from query
    const subjectMatch = lowerQuestion.match(/who teaches\s+(.+?)(?:\s+subject|\s+class|\?|$)/i) ||
      lowerQuestion.match(/teacher of\s+(.+?)(?:\?|$)/i);
    const subjectName = subjectMatch ? subjectMatch[1].trim() : 'this subject';

    if (results.length === 1) {
      const teacher = results[0];
      // Find the specific subject they asked about
      let subjectInfo = '';
      if (teacher.createdSubjects && teacher.createdSubjects.length > 0) {
        const matchedSubject = teacher.createdSubjects.find(s =>
          s.subject.toLowerCase().includes(subjectName.toLowerCase()) ||
          subjectName.toLowerCase().includes(s.subject.toLowerCase().split(' ')[0])
        );
        if (matchedSubject) {
          subjectInfo = ` for ${matchedSubject.stream} Semester ${matchedSubject.semester}`;
        }
      }
      return `**${teacher.name}** teaches ${subjectName.toUpperCase()}${subjectInfo}.\n\n**Email:** ${teacher.email}${teacher.phone ? `\n**Phone:** ${teacher.phone}` : ''}`;
    } else {
      // Multiple teachers
      let response = `I found **${results.length} teachers** who teach ${subjectName.toUpperCase()}:\n\n`;
      results.forEach((teacher, i) => {
        response += `${i + 1}. **${teacher.name}** - ${teacher.email}\n`;
      });
      return response;
    }
  }

  // Handle Mentorship "Who is the mentor" queries - give simple direct answer
  const isMentorQuery = lowerQuestion.includes('mentor for') ||
    lowerQuestion.includes('who is the mentor') ||
    lowerQuestion.includes('which teacher mentors');

  if (isMentorQuery || lowerQuestion.includes('mentor')) {
    const studentMatch = lowerQuestion.match(/mentor\s+(?:for|of)\s+([^?]+)/i);
    const sName = (studentMatch ? studentMatch[1].trim() : '').toLowerCase();
    const sID = (extractStudentID(question) || '').toUpperCase();

    if (queryInfo.collection === 'teachers' && Array.isArray(results) && results.length > 0) {
      const searchName = sName.replace(/\s+/g, ' ').trim();

      for (const teacher of results) {
        if (!teacher.mentees) continue;

        const mentee = teacher.mentees.find(m => {
          const mName = (m.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
          const mID = (m.studentID || '').toUpperCase();
          return (sID && mID === sID) || (searchName && mName.includes(searchName));
        });

        if (mentee) {
          return `**${teacher.name}** is the assigned mentor for student **${mentee.name}** (${mentee.studentID}).\n\n**Mentor Contact:** ${teacher.email}${teacher.phone ? ` | ${teacher.phone}` : ''}`;
        }
      }
      console.log(`❌ [Mentorship Match] No mentee found matching "${searchName}" in any teacher in results`);
    } else if (queryInfo.collection === 'students' && Array.isArray(results) && results.length === 1) {
      // Fallback if it hit students collection for some reason
      const student = results[0];
      if (student.mentorName || student.mentorEmail) {
        const mentorDisplay = student.mentorName || student.mentorEmail.split('@')[0].split('.').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
        return `**${mentorDisplay}** is the assigned mentor for student **${student.name}** (${student.studentID}).\n\n**Mentor Contact:** ${student.mentorEmail || 'N/A'}`;
      }
    }
  }

  // Handle "List mentees" queries
  if (queryInfo.collection === 'teachers' && (lowerQuestion.includes('mentees') || lowerQuestion.includes('assigned students')) && Array.isArray(results) && results.length === 1) {
    const teacher = results[0];
    const mentees = teacher.mentees || [];
    if (mentees.length === 0) {
      return `**${teacher.name}** has no students assigned for mentorship at the moment.`;
    }
    let response = `**${teacher.name}** is currently mentoring **${mentees.length} students**:\n\n`;
    mentees.forEach((m, i) => {
      response += `${i + 1}. **${m.name}** (${m.studentID}) - ${m.stream} Sem ${m.semester}\n`;
    });
    return response;
  }

  // Try table formatting first for list responses
  const tableFormat = formatAsTable(results, queryInfo.collection, question);
  if (tableFormat) {
    console.log(`✅ Using table format response with natural intro`);
    return tableFormat;
  }

  // Fallback to AI generation for complex queries or profile views
  console.log(`⚠️ Using AI generation fallback`);
  return await generateAIResponse(question, results, queryInfo);
}


// ============================================================================
// AI-GENERATED RESPONSE - ALWAYS WITH ACCURATE INTRO
// ============================================================================

async function generateAIResponse(question, results, queryInfo) {
  const now = new Date();
  const currentDateTime = now.toISOString().replace('T', ' ').substring(0, 19);

  // Instead of sending raw data to AI, pre-format it in code first
  const resultCount = Array.isArray(results) ? results.length : 1;
  const intro = generateNaturalIntro(question, results, queryInfo.collection);

  // For small result sets, format them directly in code
  if (Array.isArray(results) && results.length <= 5) {
    let formatted = `${intro}\n\n`;

    results.forEach((item, i) => {
      formatted += `### ${i + 1}. `;
      if (item.name) formatted += `${item.name}`;
      else if (item.subject) formatted += `${item.subject}`;
      else formatted += `Record ${i + 1}`;
      formatted += '\n\n';

      // Show all fields as key-value pairs
      Object.entries(item).forEach(([key, value]) => {
        if (key === '_id' || key === '__v') return;
        if (value === null || value === undefined) return;

        const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();

        if (Array.isArray(value)) {
          if (value.length > 0 && typeof value[0] === 'object') {
            formatted += `**${label}:** ${value.length} items\n`;
            value.slice(0, 10).forEach(v => {
              const summary = Object.values(v).filter(x => typeof x === 'string' || typeof x === 'number').join(' | ');
              formatted += `  - ${summary}\n`;
            });
          } else {
            formatted += `**${label}:** ${value.join(', ')}\n`;
          }
        } else if (typeof value === 'object') {
          formatted += `**${label}:** ${JSON.stringify(value)}\n`;
        } else {
          formatted += `**${label}:** ${value}\n`;
        }
      });
      formatted += '\n';
    });

    return formatted;
  }

  // For larger result sets that don't match any table format, use a simple summary
  if (Array.isArray(results) && results.length > 5) {
    let formatted = `${intro}\n\n`;
    const sample = results.slice(0, 10);

    sample.forEach((item, i) => {
      const values = Object.entries(item)
        .filter(([k, v]) => k !== '_id' && k !== '__v' && v !== null && v !== undefined)
        .map(([k, v]) => {
          if (Array.isArray(v)) return `${k}: ${v.length} items`;
          if (typeof v === 'object') return null;
          return `${k}: ${v}`;
        })
        .filter(Boolean)
        .join(' | ');
      formatted += `${i + 1}. ${values}\n`;
    });

    if (results.length > 10) {
      formatted += `\n*...and ${results.length - 10} more records*\n`;
    }

    return formatted;
  }

  // Only use AI as absolute last resort for single complex objects
  const resultsPreview = Array.isArray(results) ? results.slice(0, 5) : results;

  const prompt = `Format this database result as a clean, readable response. ONLY use the exact data provided - NEVER add or change any values.

USER ASKED: "${question}"
DATA: ${JSON.stringify(resultsPreview, null, 2)}

Rules:
- Use EXACT values from the data above
- Use markdown formatting (bold, headers, lists)
- Be brief and accurate
- NEVER invent data not shown above
- Say "Not available" for missing fields`;

  try {
    const response = await geminiService.generateResponse(prompt);
    return response.trim();
  } catch (error) {
    console.error('⚠️ AI generation failed:', error);
    return friendlyFormatResults(results, question, queryInfo.collection);
  }
}


// ============================================================================
// FALLBACK FORMATTING - ACCURATE WITH INTRO
// ============================================================================

function friendlyFormatResults(results, question, collection) {
  if (!results) {
    return "I couldn't find any data matching your query in the database. This could be because:\n• The record doesn't exist\n• There's a spelling error\n• The search criteria is too specific\n\nPlease try again with different search terms.";
  }

  if (typeof results === 'number') {
    const intro = generateNaturalIntro(question, results, collection);
    return `${intro}\n\n## Total Count: **${results}**\n\nThis is the exact number of ${collection} records in the database matching your criteria.`;
  }

  if (Array.isArray(results)) {
    if (results.length === 0) {
      return "I searched the database but couldn't find any records matching your criteria. Please check:\n• Spelling of names\n• Stream or semester numbers\n• Date formats\n\n**Example queries:**\n• \"List all BCA students\"\n• \"Show teachers in Computer Science\"\n• \"Attendance for today\"";
    }

    const intro = generateNaturalIntro(question, results, collection);
    const tableFormat = formatAsTable(results, collection, question);
    if (tableFormat) {
      return tableFormat;
    }

    let formatted = `${intro}\n\n`;

    const firstItem = results[0];

    if (firstItem.name && firstItem.email) {
      // Teachers - natural language format
      results.slice(0, 10).forEach((teacher, i) => {
        formatted += `### ${i + 1}. ${teacher.name}\n\n`;
        formatted += `**Email:** ${teacher.email}\n`;

        if (teacher.phone) {
          formatted += `**Phone:** ${teacher.phone}\n`;
        }

        if (teacher.department) {
          formatted += `**Department:** ${teacher.department}\n`;
        }

        if (teacher.createdSubjects && teacher.createdSubjects.length > 0) {
          formatted += `\n**Teaching ${teacher.createdSubjects.length} Subject${teacher.createdSubjects.length !== 1 ? 's' : ''}:**\n\n`;
          teacher.createdSubjects.slice(0, 5).forEach((subj) => {
            formatted += `• ${subj.subject}`;
            if (subj.subjectCode) formatted += ` (${subj.subjectCode})`;
            formatted += ` - ${subj.stream} Semester ${subj.semester}\n`;
          });
          if (teacher.createdSubjects.length > 5) {
            formatted += `• ... and ${teacher.createdSubjects.length - 5} more subjects\n`;
          }
        } else {
          formatted += `\n**Subjects:** No teaching assignments currently\n`;
        }

        formatted += `\n`;
      });

      if (results.length > 10) {
        formatted += `\n*Showing first 10 of ${results.length} teachers. +${results.length - 10} more available.*\n`;
      }
    } else {
      formatted += results.slice(0, 10).map((item, i) =>
        `${i + 1}. ${JSON.stringify(item).substring(0, 80)}...`
      ).join('\n\n');

      if (results.length > 10) {
        formatted += `\n\n*+${results.length - 10} more records available*`;
      }
    }

    return formatted;
  }

  return `I found the information you requested. Here are the exact details from the database:\n\n${JSON.stringify(results, null, 2)}`;
}


// ============================================================================
// FORMAT ATTENDANCE REPORT - ACCURATE WITH NATURAL INTRO
// ============================================================================

function formatAttendanceReport(data) {
  if (!data || data.length === 0) {
    return "I couldn't find any attendance records for this student. Please verify the name and try again.";
  }

  const student = data[0];

  // Calculate statistics
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
// GET CURRENT DATE TIME
// ============================================================================

function getCurrentDateTime() {
  const now = new Date();
  return {
    date: now.toISOString().split('T')[0],
    dateTime: now.toISOString().replace('T', ' ').substring(0, 19),
    formatted: now.toLocaleString('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).replace(',', '')
  };
}


// ============================================================================
// MAIN HANDLER - ORCHESTRATES ENTIRE FLOW
// ============================================================================

async function handleLLMChat(message, userId = 'anonymous') {
  const startTime = Date.now();

  console.log(`\n${'█'.repeat(70)}`);
  console.log(`█ 🚀 LLM CHAT REQUEST - ${new Date().toISOString()}`);
  console.log(`█ User: ${userId}`);
  console.log(`█ Message: "${message}"`);
  console.log(`${'█'.repeat(70)}\n`);

  try {
    // Step 1: Generate MongoDB query
    const queryInfo = await generateMongoQuery(message);

    // Step 2: Execute query
    const results = await executeQuery(queryInfo);

    // Step 3: Check if it's attendance data - use special formatter
    let response;
    if (queryInfo.collection === 'students' &&
      queryInfo.operation === 'aggregate' &&
      Array.isArray(results) &&
      results.length > 0 &&
      results[0].attendancePercentage) {
      response = formatAttendanceReport(results);
    } else {
      // Step 3: Generate natural response
      response = await generateNaturalResponse(message, results, queryInfo);
    }

    const duration = Date.now() - startTime;

    console.log(`${'█'.repeat(70)}`);
    console.log(`█ ✅ CHAT COMPLETED - ${duration}ms`);
    console.log(`${'█'.repeat(70)}\n`);

    return {
      success: true,
      response,
      metadata: {
        collection: queryInfo.collection,
        operation: queryInfo.operation,
        resultCount: Array.isArray(results) ? results.length : (typeof results === 'number' ? results : 1),
        processingTime: `${duration}ms`,
        timestamp: new Date(),
        userId
      }
    };

  } catch (error) {
    const duration = Date.now() - startTime;

    console.log(`${'█'.repeat(70)}`);
    console.log(`█ ❌ CHAT FAILED - ${duration}ms`);
    console.log(`█ Error: ${error.message}`);
    console.log(`${'█'.repeat(70)}\n`);

    // Parse error message for specific cases
    const errorMsg = error.message;

    if (errorMsg.startsWith('STUDENT_NOT_FOUND:')) {
      const studentName = errorMsg.split(':')[1];
      return {
        success: false,
        error: `Student "${studentName}" not found`,
        suggestion: `The student "${studentName}" is not registered in the system. Please check the spelling and try again.`,
        timestamp: new Date(),
        userId
      };
    }

    if (errorMsg.startsWith('NO_ATTENDANCE_RECORDS:')) {
      const parts = errorMsg.split(':');
      const studentName = parts[1];
      const stream = parts[2];
      const semester = parts[3];
      return {
        success: false,
        error: `No attendance records found`,
        suggestion: `${studentName} is enrolled in ${stream} Semester ${semester}, but no attendance records exist for this stream/semester combination yet. Classes may not have been conducted.`,
        timestamp: new Date(),
        userId
      };
    }

    if (errorMsg.startsWith('STUDENT_EXISTS_NO_ATTENDANCE:')) {
      const parts = errorMsg.split(':');
      const studentName = parts[1];
      const stream = parts[2];
      const semester = parts[3];
      const studentID = parts[4];
      return {
        success: false,
        error: `No attendance data`,
        suggestion: `${studentName} (${studentID}) is registered in ${stream} Semester ${semester}, but they have not attended any classes yet or the attendance hasn't been recorded.`,
        timestamp: new Date(),
        userId
      };
    }

    return {
      success: false,
      error: error.message,
      suggestion: 'Please rephrase your question or try a simpler query',
      timestamp: new Date(),
      userId
    };
  }
}


// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  generateMongoQuery,
  executeQuery,
  generateNaturalResponse,
  friendlyFormatResults,
  formatAttendanceReport,
  formatAsTable,
  getCurrentDateTime,
  parseDateFromQuery,
  buildStudentAttendanceQuery,
  handleLLMChat,
  generateNaturalIntro,
  generateAIResponse
};
