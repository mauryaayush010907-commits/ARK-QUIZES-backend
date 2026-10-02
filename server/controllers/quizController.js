import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { Answer, Attempt, GameWinner, Participant, Question, Quiz, Team, User } from "../models/index.js";
import { signToken } from "../middleware/auth.js";
import { computeQuizStatus, generateQuizCode, generateTeamCode, httpError, publicUser, sanitizeQuestion } from "../utils/helpers.js";

const INTEGRITY_EVENT_LIMIT = 100;
const CLIENT_INTEGRITY_REASONS = {
  TAB_SWITCH: "Quiz page became hidden",
  PAGE_HIDDEN: "Quiz page became hidden",
  WINDOW_BLUR: "Quiz window lost focus",
  FULLSCREEN_EXIT: "Student exited fullscreen mode during the quiz",
  PAGE_LEFT: "Student left the active quiz page",
};

async function findActiveIntegrityRecord(attemptId, userId) {
  if (!mongoose.isValidObjectId(attemptId)) return null;
  const attempt = await Attempt.findOne({ _id: attemptId, userId });
  if (attempt) {
    const quiz = await Quiz.findById(attempt.quizId);
    const active = attempt.status === "in_progress" && attempt.attemptStatus !== "TERMINATED" && quiz?.mode === "scheduled" &&
      computeQuizStatus(quiz) === "LIVE" && (!attempt.expiresAt || attempt.expiresAt.getTime() > Date.now());
    return { record: attempt, quiz, active };
  }

  const participant = await Participant.findOne({ _id: attemptId, userId });
  if (!participant) return null;
  const quiz = await Quiz.findById(participant.quizId);
  return {
    record: participant,
    quiz,
    active: Boolean(quiz && ["live", "game"].includes(quiz.mode) && quiz.status === "LIVE" && participant.attemptStatus !== "TERMINATED"),
  };
}

export async function recordIntegrityEvent(req, res) {
  if (req.user.role !== "student") throw httpError(403, "Student account required");
  const { type, sessionId, clientTimestamp, duration } = req.body || {};
  const reason = CLIENT_INTEGRITY_REASONS[type];
  if (!reason) throw httpError(400, "Unsupported integrity event");
  if (typeof sessionId !== "string" || sessionId.length < 16 || sessionId.length > 128) {
    throw httpError(400, "A valid quiz session ID is required");
  }

  const eventTime = new Date(clientTimestamp);
  const now = Date.now();
  if (!Number.isFinite(eventTime.getTime()) || eventTime.getTime() < now - 86_400_000 || eventTime.getTime() > now + 30_000) {
    throw httpError(400, "Event timestamp is outside the accepted window");
  }
  if (duration !== undefined && (!Number.isFinite(duration) || duration < 0 || duration > 3600)) {
    throw httpError(400, "Event duration is invalid");
  }

  const resolved = await findActiveIntegrityRecord(req.params.attemptId, req.user._id);
  if (!resolved) throw httpError(404, "Active quiz attempt not found");
  const { record, quiz, active } = resolved;
  if (!active || !quiz) throw httpError(409, "This quiz attempt has been terminated.", "ATTEMPT_TERMINATED");
  if (record.sessionId !== sessionId) throw httpError(409, "Quiz session does not match the active attempt.", "SESSION_MISMATCH");
  const activeSince = (record.startedAt || record.joinedAt)?.getTime();
  if (activeSince && eventTime.getTime() < activeSince) throw httpError(400, "Event timestamp predates this attempt");

  const serverTime = new Date();
  const event = {
    _id: new mongoose.Types.ObjectId(),
    quizId: quiz._id,
    attemptId: record._id,
    studentId: req.user._id,
    sessionId,
    type,
    reason,
    timestamp: serverTime,
    clientTimestamp: eventTime,
    ...(duration === undefined ? {} : { duration }),
    receivedAt: serverTime,
  };
  const isAttempt = record instanceof Attempt;
  const activeFilter = isAttempt
    ? { status: "in_progress", attemptStatus: { $ne: "TERMINATED" } }
    : { attemptStatus: { $ne: "TERMINATED" } };
  const terminationFields = {
    integrityStatus: "CHEATING",
    attemptStatus: "TERMINATED",
    terminationReason: type,
    terminatedAt: serverTime,
    terminatedBy: "INTEGRITY_SYSTEM",
    lastIntegrityEventAt: serverTime,
    lastHeartbeatAt: serverTime,
    integrityViolation: event,
    ...(isAttempt ? {
      status: "terminated",
      submittedAt: serverTime,
      timeTaken: Math.max(0, now - new Date(record.startedAt).getTime()),
    } : { status: "terminated" }),
  };
  const updated = await record.constructor.findOneAndUpdate(
    { _id: record._id, userId: req.user._id, sessionId, integrityStatus: { $ne: "CHEATING" }, ...activeFilter },
    {
      $inc: { integrityViolationCount: 1 },
      $set: terminationFields,
      $push: {
        integrityEvents: { $each: [event], $slice: -INTEGRITY_EVENT_LIMIT },
      },
    },
    { new: true }
  );

  if (!updated) {
    const latest = await record.constructor.findById(record._id).select("attemptStatus sessionId").lean();
    if (latest?.sessionId !== sessionId) throw httpError(409, "Quiz session does not match the active attempt.", "SESSION_MISMATCH");
    throw httpError(409, "This quiz attempt has already been terminated.", "ATTEMPT_TERMINATED");
  }

  const savedViolation = updated.integrityEvents.at(-1);

  const payload = {
    type: "CHEATING_ALERT",
    quizId: String(quiz._id),
    attemptId: String(record._id),
    studentId: String(req.user._id),
    studentName: req.user.name,
    eventType: type,
    reason,
    integrityStatus: "CHEATING",
    attemptStatus: "TERMINATED",
    terminationReason: type,
    violationCount: updated.integrityViolationCount,
    timestamp: savedViolation.timestamp,
    duration: savedViolation.duration,
    eventId: String(savedViolation._id),
  };

  if (["live", "game"].includes(quiz.mode) && quiz.status === "LIVE") {
    const io = req.app.get("io");
    io?.to(`quiz:${quiz._id}:admins`).emit("CHEATING_ALERT", payload);
    io?.to(`quiz:${quiz._id}:admins`).emit("quiz:integrityUpdated", payload);
  }

  res.status(201).json({
    success: true,
    eventId: payload.eventId,
    integrityStatus: "CHEATING",
    attemptStatus: "TERMINATED",
    terminationReason: type,
    violationCount: updated.integrityViolationCount,
    violation: savedViolation,
  });
}

export async function heartbeatAttempt(req, res) {
  if (req.user.role !== "student") throw httpError(403, "Student account required");
  const { sessionId } = req.body || {};
  if (typeof sessionId !== "string" || sessionId.length < 16 || sessionId.length > 128) {
    throw httpError(400, "A valid quiz session ID is required");
  }
  const resolved = await findActiveIntegrityRecord(req.params.attemptId, req.user._id);
  if (!resolved) throw httpError(404, "Active quiz attempt not found");
  if (!resolved.active) throw httpError(409, "This quiz attempt has been terminated.", "ATTEMPT_TERMINATED");
  if (resolved.record.sessionId && resolved.record.sessionId !== sessionId) {
    throw httpError(409, "Another active quiz session owns this attempt.", "SESSION_MISMATCH");
  }
  const updated = await resolved.record.constructor.findOneAndUpdate(
    { _id: resolved.record._id, userId: req.user._id, $or: [{ sessionId }, { sessionId: null }] },
    { $set: { sessionId, lastHeartbeatAt: new Date() } },
    { new: true }
  );
  if (!updated) throw httpError(409, "Another active quiz session owns this attempt.", "SESSION_MISMATCH");
  res.json({ ok: true, serverNow: Date.now() });
}

export async function heartbeatParticipant(req, res) {
  if (req.user.role === "admin") {
    const quiz = await Quiz.findOne({ _id: req.params.quizId, createdBy: req.user._id }).select("_id").lean();
    if (!quiz) throw httpError(404, "Quiz not found");
    return res.json({ ok: true, serverNow: Date.now() });
  }
  const { sessionId } = req.body || {};
  const participant = await Participant.findOne({ quizId: req.params.quizId, userId: req.user._id });
  if (!participant) throw httpError(404, "Quiz participant not found");
  if (participant.attemptStatus === "TERMINATED") throw httpError(409, "This quiz attempt has been terminated.", "ATTEMPT_TERMINATED");
  if (sessionId && participant.sessionId && participant.sessionId !== sessionId) {
    throw httpError(409, "Another active quiz session owns this attempt.", "SESSION_MISMATCH");
  }
  if (sessionId) participant.sessionId = sessionId;
  participant.lastHeartbeatAt = new Date();
  await participant.save();
  res.json({ ok: true, serverNow: Date.now() });
}

export async function getIntegritySnapshot(req, res) {
  const attempt = await Attempt.findOne({ _id: req.params.attemptId, userId: req.user._id }).lean();
  const record = attempt || await Participant.findOne({ _id: req.params.attemptId, userId: req.user._id }).lean();
  if (!record) throw httpError(404, "Quiz attempt not found");
  res.json({
    integrityStatus: record.integrityStatus || "CLEAN",
    violationCount: record.integrityViolationCount || 0,
    events: record.integrityEvents || [],
    attemptStatus: record.attemptStatus || "ACTIVE",
    terminationReason: record.terminationReason || null,
    terminatedAt: record.terminatedAt || null,
  });
}

export async function listQuizIntegrity(req, res) {
  if (req.user.role !== "admin") throw httpError(403, "Admin access required");
  const quiz = await Quiz.findOne({ _id: req.params.quizId, createdBy: req.user._id }).lean();
  if (!quiz) throw httpError(404, "Quiz not found");
  const [attempts, participants] = await Promise.all([
    Attempt.find({ quizId: quiz._id }).populate("userId", "name").lean(),
    Participant.find({ quizId: quiz._id }).lean(),
  ]);
  const records = [
    ...attempts.map((attempt) => ({
      attemptId: String(attempt._id),
      studentId: String(attempt.userId?._id || attempt.userId),
      studentName: attempt.userId?.name || "Student",
      integrityStatus: attempt.integrityStatus || "CLEAN",
      integrityViolationCount: attempt.integrityViolationCount || 0,
      attemptStatus: attempt.attemptStatus || (attempt.status === "in_progress" ? "ACTIVE" : attempt.status === "expired" ? "EXPIRED" : "SUBMITTED"),
      terminationReason: attempt.terminationReason || null,
      terminatedAt: attempt.terminatedAt || null,
      integrityEvents: attempt.integrityEvents || [],
    })),
    ...participants.filter((p) => !attempts.some((a) => String(a.userId?._id || a.userId) === String(p.userId))).map((participant) => ({
      attemptId: String(participant._id),
      studentId: String(participant.userId),
      studentName: participant.name || "Student",
      integrityStatus: participant.integrityStatus || "CLEAN",
      integrityViolationCount: participant.integrityViolationCount || 0,
      attemptStatus: participant.attemptStatus || "ACTIVE",
      terminationReason: participant.terminationReason || null,
      terminatedAt: participant.terminatedAt || null,
      integrityEvents: participant.integrityEvents || [],
    })),
  ];
  res.json(records);
}

export async function getOwnIntegrity(req, res) {
  if (req.user.role !== "student") throw httpError(403, "Student account required");
  const quiz = await Quiz.findById(req.params.quizId).select("mode").lean();
  if (!quiz) throw httpError(404, "Quiz not found");
  const record = quiz.mode === "scheduled"
    ? await Attempt.findOne({ quizId: quiz._id, userId: req.user._id }).select("integrityStatus integrityViolationCount integrityEvents attemptStatus terminationReason terminatedAt terminatedBy").lean()
    : await Participant.findOne({ quizId: quiz._id, userId: req.user._id }).select("integrityStatus integrityViolationCount integrityEvents attemptStatus terminationReason terminatedAt terminatedBy").lean();
  if (!record) throw httpError(404, "No quiz attempt found");
  res.json({
    integrityStatus: record.integrityStatus || "CLEAN",
    integrityViolationCount: record.integrityViolationCount || 0,
    integrityEvents: record.integrityEvents || [],
    attemptStatus: record.attemptStatus || "ACTIVE",
    terminationReason: record.terminationReason || null,
    terminatedAt: record.terminatedAt || null,
  });
}

export async function register(req, res) {
  const { name, email, password, role } = req.body || {};
  if (!name?.trim() || !email?.trim() || !password || password.length < 6) {
    throw httpError(400, "Name, email and a password of 6+ characters are required");
  }
  const normalizedEmail = email.toLowerCase();
  const adminEmails = new Set((process.env.ADMIN_EMAILS || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  const isAllowedAdmin = role === "admin" && adminEmails.has(normalizedEmail);
  if (role === "admin" && !isAllowedAdmin) throw httpError(403, "Admin registration is restricted to configured email addresses");
  const exists = await User.findOne({ email: normalizedEmail });
  if (exists) throw httpError(400, "An account with this email already exists");
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    passwordHash,
    role: isAllowedAdmin ? "admin" : "student",
    avatarColor: "#7c6cff",
  });
  const token = signToken(user);
  res.status(201).json({ token, user: publicUser(user) });
}

export async function login(req, res) {
  const { email, password } = req.body || {};
  const user = await User.findOne({ email: (email || "").toLowerCase() });
  if (!user || !(await bcrypt.compare(password || "", user.passwordHash))) {
    throw httpError(401, "Invalid email or password");
  }
  res.json({ token: signToken(user), user: publicUser(user) });
}

export async function me(req, res) {
  res.json({ user: publicUser(req.user) });
}

export async function createQuiz(req, res) {
  const data = req.body || {};
  if (!data.title?.trim()) throw httpError(400, "Quiz title is required");
  const quiz = await Quiz.create({
    title: data.title.trim(),
    description: data.description || "",
    mode: ["scheduled", "live", "game"].includes(data.mode) ? data.mode : "scheduled",
    status: data.mode === "scheduled" && data.publish ? "SCHEDULED" : "DRAFT",
    startTime: data.startTime || null,
    endTime: data.endTime || null,
    duration: Number(data.duration) || 30,
    marksPerQuestion: Number(data.marksPerQuestion) || 1,
    negativeMarking: Boolean(data.negativeMarking),
    negativePoints: Number(data.negativePoints) || 0,
    maxParticipants: data.maxParticipants || null,
    quizCode: (data.quizCode || generateQuizCode()).toUpperCase(),
    instructions: data.instructions || "",
    teamMode: Boolean(data.teamMode),
    showAnswersAfter: Boolean(data.showAnswersAfter),
    showLeaderboard: data.showLeaderboard !== false,
    questionTimeLimit: Number(data.questionTimeLimit) || 30,
    createdBy: req.user._id,
  });
  res.status(201).json(quiz);
}

export async function listQuizzes(req, res) {
  const { search, mode, status, page = 1, limit = 10, sort = "createdAt" } = req.query;
  const filter = {};
  if (mode) filter.mode = mode;
  if (status) filter.status = status;
  if (search) filter.$or = [{ title: new RegExp(search, "i") }, { quizCode: new RegExp(search, "i") }];
  if (req.user.role !== "admin") {
    const mine = await Participant.find({ userId: req.user._id }).distinct("quizId");
    filter._id = { $in: mine };
  }
  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    Quiz.find(filter).sort({ [sort]: -1 }).skip(skip).limit(Number(limit)).lean(),
    Quiz.countDocuments(filter),
  ]);
  const withCounts = await Promise.all(
    items.map(async (q) => ({
      ...q,
      computedStatus: computeQuizStatus(q),
      questionCount: await Question.countDocuments({ quizId: q._id }),
      participantCount: await Participant.countDocuments({ quizId: q._id }),
    }))
  );
  res.json({ items: withCounts, total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit) || 1) });
}

export async function getQuiz(req, res) {
  const quiz = await Quiz.findById(req.params.id).lean();
  if (!quiz) throw httpError(404, "Quiz not found");
  const hide = req.user.role !== "admin";
  const questions = (await Question.find({ quizId: quiz._id }).sort({ order: 1 }).lean()).map((q) => sanitizeQuestion(q, hide));
  res.json({
    ...quiz,
    computedStatus: computeQuizStatus(quiz),
    questions,
    questionCount: questions.length,
    participantCount: await Participant.countDocuments({ quizId: quiz._id }),
  });
}

export async function updateQuiz(req, res) {
  const quiz = await Quiz.findById(req.params.id);
  if (!quiz) throw httpError(404, "Quiz not found");
  if (["LIVE", "COMPLETED", "EXPIRED"].includes(quiz.status) && req.body.mode && req.body.mode !== quiz.mode) {
    throw httpError(400, "Cannot change mode of an active or finished quiz");
  }
  const allowed = ["title", "description", "instructions", "showAnswersAfter", "showLeaderboard", "status"];
  if (!["LIVE", "COMPLETED", "EXPIRED", "CANCELLED"].includes(quiz.status)) {
    allowed.push("mode", "startTime", "endTime", "duration", "marksPerQuestion", "negativeMarking", "negativePoints", "maxParticipants", "teamMode", "questionTimeLimit", "quizCode");
  }
  allowed.forEach((k) => {
    if (req.body[k] !== undefined) quiz[k] = req.body[k];
  });
  if (req.body.publish && quiz.mode === "scheduled" && quiz.status === "DRAFT") {
    quiz.status = "SCHEDULED";
  }
  await quiz.save();
  res.json(quiz);
}

export async function deleteQuiz(req, res) {
  const quiz = await Quiz.findById(req.params.id);
  if (!quiz) throw httpError(404, "Quiz not found");
  if (quiz.status === "LIVE") throw httpError(400, "End the live quiz before deleting it");
  const id = quiz._id;
  await Promise.all([
    Quiz.deleteOne({ _id: id }),
    Question.deleteMany({ quizId: id }),
    Participant.deleteMany({ quizId: id }),
    Team.deleteMany({ quizId: id }),
    Attempt.deleteMany({ quizId: id }),
    Answer.deleteMany({ quizId: id }),
    GameWinner.deleteMany({ quizId: id }),
  ]);
  res.json({ ok: true });
}

export async function duplicateQuiz(req, res) {
  const source = await Quiz.findOne({ _id: req.params.id, createdBy: req.user._id }).lean();
  if (!source) throw httpError(404, "Quiz not found");
  const { _id, createdAt, updatedAt, __v, ...fields } = source;
  const quiz = await Quiz.create({
    ...fields,
    title: `Copy of ${source.title}`,
    quizCode: generateQuizCode(),
    status: "DRAFT",
    createdBy: req.user._id,
    currentQuestionId: null,
    currentQuestionIndex: -1,
    questionStartedAt: null,
    questionPaused: false,
    pausedRemaining: null,
    lobbyOpen: false,
    startedAt: null,
    endedAt: null,
  });
  const questions = await Question.find({ quizId: source._id }).sort({ order: 1 }).lean();
  await Question.insertMany(questions.map((question) => {
    const { _id: questionId, createdAt: questionCreatedAt, updatedAt: questionUpdatedAt, __v: questionVersion, ...questionFields } = question;
    return { ...questionFields, quizId: quiz._id };
  }));
  res.status(201).json(quiz);
}

export async function addQuestion(req, res) {
  const quiz = await Quiz.findById(req.params.quizId);
  if (!quiz) throw httpError(404, "Quiz not found");
  const options = (req.body.options || []).map((o, i) => ({
    id: o.id || String.fromCharCode(65 + i),
    text: (o.text || o).toString(),
  }));
  if (!req.body.text?.trim() || options.length < 2) throw httpError(400, "Question text and two options are required");
  const last = await Question.findOne({ quizId: quiz._id }).sort({ order: -1 });
  const question = await Question.create({
    quizId: quiz._id,
    text: req.body.text.trim(),
    image: req.body.image || "",
    options,
    correctOptionId: req.body.correctOptionId,
    points: Number(req.body.points) || quiz.marksPerQuestion,
    negativePoints: Number(req.body.negativePoints) || quiz.negativePoints,
    explanation: req.body.explanation || "",
    order: req.body.order ?? (last ? last.order + 1 : 0),
    timeLimit: Number(req.body.timeLimit) || quiz.questionTimeLimit,
  });
  res.status(201).json(question);
}

export async function updateQuestion(req, res) {
  const question = await Question.findById(req.params.id);
  if (!question) throw httpError(404, "Question not found");
  const answered = await Answer.exists({ questionId: question._id });
  if (answered && req.body.correctOptionId && req.body.correctOptionId !== question.correctOptionId) {
    throw httpError(400, "Completed questions are immutable");
  }
  ["text", "image", "options", "correctOptionId", "points", "negativePoints", "explanation", "order", "timeLimit"].forEach((k) => {
    if (req.body[k] !== undefined) question[k] = req.body[k];
  });
  await question.save();
  const io = req.app.get("io");
  const quiz = await Quiz.findById(question.quizId);
  if (quiz?.status === "LIVE" && String(quiz.currentQuestionId) === String(question._id)) {
    io.to(`quiz:${quiz._id}`).emit("quiz:questionUpdated", { quizId: String(quiz._id), question: sanitizeQuestion(question, true) });
  }
  res.json(question);
}

export async function deleteQuestion(req, res) {
  const question = await Question.findById(req.params.id);
  if (!question) throw httpError(404, "Question not found");
  if (await Answer.exists({ questionId: question._id })) throw httpError(400, "Cannot delete a question that already has answers");
  await question.deleteOne();
  res.json({ ok: true });
}

export async function duplicateQuestion(req, res) {
  const question = await Question.findById(req.params.id).lean();
  if (!question) throw httpError(404, "Question not found");
  const last = await Question.findOne({ quizId: question.quizId }).sort({ order: -1 }).lean();
  const { _id, createdAt, updatedAt, __v, ...copy } = question;
  const duplicated = await Question.create({ ...copy, order: (last?.order ?? -1) + 1 });
  res.status(201).json(duplicated);
}

export async function reorderQuestions(req, res) {
  const ids = req.body.orderedIds || [];
  await Promise.all(ids.map((id, i) => Question.updateOne({ _id: id, quizId: req.params.quizId }, { order: i })));
  res.json({ ok: true });
}

export async function importQuestions(req, res) {
  const items = req.body.items || [];
  const created = [];
  const errors = [];
  for (let i = 0; i < items.length; i++) {
    try {
      req.body = items[i];
      req.params.quizId = req.params.quizId;
      const fakeRes = { status() { return this; }, json(q) { created.push(q); } };
      await addQuestion(req, fakeRes);
    } catch (e) {
      errors.push({ index: i, error: e.message });
    }
  }
  res.json({ created: created.length, invalid: errors.length, errors, questions: created });
}

export async function joinQuiz(req, res) {
  const quiz = req.body.quizId
    ? await Quiz.findById(req.body.quizId)
    : await Quiz.findOne({ quizCode: (req.body.quizCode || "").toUpperCase() });
  if (!quiz) throw httpError(404, "Invalid quiz code");
  const status = computeQuizStatus(quiz);
  if (["COMPLETED", "EXPIRED", "CANCELLED"].includes(status)) throw httpError(400, "This quiz is no longer accepting participants");
  if (quiz.mode === "scheduled" && status === "SCHEDULED") throw httpError(400, "This quiz has not started yet");
  if ((quiz.mode === "live" || quiz.mode === "game") && !quiz.lobbyOpen && status !== "LIVE") {
    throw httpError(400, "The host has not opened the lobby yet");
  }
  if (quiz.maxParticipants) {
    const count = await Participant.countDocuments({ quizId: quiz._id });
    if (count >= quiz.maxParticipants) throw httpError(400, "This quiz has reached its participant limit");
  }
  let team = null;
  if (quiz.teamMode) {
    if (req.body.teamCode) {
      team = await Team.findOne({ quizId: quiz._id, code: req.body.teamCode.toUpperCase() });
      if (!team) throw httpError(400, "Invalid team code");
      if (!team.members.find((m) => String(m) === String(req.user._id))) {
        team.members.push(req.user._id);
        await team.save();
      }
    } else if (req.body.teamName) {
      team = await Team.findOne({ quizId: quiz._id, name: req.body.teamName.trim() });
      if (!team) {
        team = await Team.create({
          quizId: quiz._id,
          name: req.body.teamName.trim(),
          code: generateTeamCode(),
          leaderId: req.user._id,
          members: [req.user._id],
        });
      }
    } else throw httpError(400, "Join or create a team to continue");
  }
  const participant = await Participant.findOneAndUpdate(
    { quizId: quiz._id, userId: req.user._id },
    { $setOnInsert: { name: req.user.name, teamId: team?._id, joinedAt: new Date() } },
    { upsert: true, new: true }
  );
  if (participant.attemptStatus === "TERMINATED") {
    throw httpError(409, "This quiz attempt has been terminated.", "ATTEMPT_TERMINATED");
  }
  req.app.get("io")?.to(`quiz:${quiz._id}`).emit("quiz:participantJoined", {
    quizId: String(quiz._id),
    participant: { _id: participant._id, name: participant.name, teamId: participant.teamId },
  });
  res.json({ quiz, participant, team });
}

export async function startAttempt(req, res) {
  const quiz = await Quiz.findById(req.params.quizId);
  if (!quiz) throw httpError(404, "Quiz not found");
  const status = computeQuizStatus(quiz);
  if (status === "EXPIRED") throw httpError(410, "Quiz Expired");
  if (quiz.mode !== "scheduled" || status !== "LIVE") throw httpError(400, "Quiz is not available yet");
  const sessionId = req.body?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length < 16 || sessionId.length > 128) {
    throw httpError(400, "A valid quiz session ID is required");
  }
  let participant = await Participant.findOne({ quizId: quiz._id, userId: req.user._id });
  if (!participant) {
    participant = await Participant.create({ quizId: quiz._id, userId: req.user._id, name: req.user.name });
  }
  let attempt = await Attempt.findOne({ quizId: quiz._id, userId: req.user._id });
  if (attempt?.status === "terminated" || attempt?.attemptStatus === "TERMINATED") {
    throw httpError(409, "This quiz attempt has been terminated.", "ATTEMPT_TERMINATED");
  }
  if (attempt && attempt.status !== "in_progress") throw httpError(400, "You have already submitted this quiz");
  if (attempt?.sessionId && attempt.sessionId !== sessionId) {
    throw httpError(409, "Another active quiz session owns this attempt.", "SESSION_MISMATCH");
  }
  if (!attempt) {
    const durationMs = (quiz.duration || 30) * 60 * 1000;
    const end = quiz.endTime ? new Date(quiz.endTime).getTime() : Date.now() + durationMs;
    attempt = await Attempt.create({
      quizId: quiz._id,
      participantId: participant._id,
      userId: req.user._id,
      startedAt: new Date(),
      expiresAt: new Date(Math.min(Date.now() + durationMs, end)),
      status: "in_progress",
      attemptStatus: "ACTIVE",
      sessionId,
      lastHeartbeatAt: new Date(),
    });
  } else if (!attempt.sessionId) {
    attempt.sessionId = sessionId;
    await attempt.save();
  }
  const questions = (await Question.find({ quizId: quiz._id }).sort({ order: 1 }).lean()).map((q) => sanitizeQuestion(q, true));
  const answers = await Answer.find({ attemptId: attempt._id }).lean();
  res.json({
    attempt,
    quiz,
    questions,
    answers: answers.map((a) => ({ questionId: a.questionId, selectedOptionId: a.selectedOptionId })),
    serverNow: Date.now(),
  });
}

export async function saveAnswer(req, res) {
  const quiz = await Quiz.findById(req.params.quizId);
  if (!quiz) throw httpError(404, "Quiz not found");
  if (computeQuizStatus(quiz) === "EXPIRED") throw httpError(410, "Quiz Expired");
  const existingAttempt = await Attempt.findOne({ quizId: quiz._id, userId: req.user._id });
  if (existingAttempt?.status === "terminated" || existingAttempt?.attemptStatus === "TERMINATED") {
    throw httpError(409, "This quiz attempt has been terminated.", "ATTEMPT_TERMINATED");
  }
  const attempt = existingAttempt?.status === "in_progress" ? existingAttempt : null;
  if (!attempt) throw httpError(400, "No active attempt");
  if (req.body.sessionId !== attempt.sessionId) {
    throw httpError(409, "Another active quiz session owns this attempt.", "SESSION_MISMATCH");
  }
  if (attempt.expiresAt && Date.now() > new Date(attempt.expiresAt).getTime()) throw httpError(400, "Time is up");
  const question = await Question.findOne({ _id: req.body.questionId, quizId: quiz._id });
  if (!question) throw httpError(400, "Question does not belong to this quiz");
  const isCorrect = req.body.selectedOptionId === question.correctOptionId;
  await Answer.findOneAndUpdate(
    { attemptId: attempt._id, questionId: question._id },
    {
      quizId: quiz._id,
      questionId: question._id,
      participantId: attempt.participantId,
      userId: req.user._id,
      attemptId: attempt._id,
      selectedOptionId: req.body.selectedOptionId,
      isCorrect,
      serverTimestamp: new Date(),
      responseTimeMs: Date.now() - new Date(attempt.startedAt).getTime(),
    },
    { upsert: true }
  );
  res.json({ ok: true, serverNow: Date.now() });
}

async function scoreAttempt(attempt) {
  const quiz = await Quiz.findById(attempt.quizId);
  const questions = await Question.find({ quizId: attempt.quizId });
  const answers = await Answer.find({ attemptId: attempt._id });
  let score = 0;
  let correct = 0;
  let incorrect = 0;
  answers.forEach((ans) => {
    const q = questions.find((x) => String(x._id) === String(ans.questionId));
    const pts = q?.points ?? quiz.marksPerQuestion ?? 1;
    const neg = q?.negativePoints ?? quiz.negativePoints ?? 0;
    if (ans.isCorrect) {
      score += pts;
      correct += 1;
    } else {
      incorrect += 1;
      if (quiz.negativeMarking) score -= neg;
    }
  });
  attempt.score = score;
  attempt.correctCount = correct;
  attempt.incorrectCount = incorrect;
  attempt.attemptedCount = answers.length;
  await attempt.save();
  await Participant.updateOne({ _id: attempt.participantId }, { score, correctCount: correct, incorrectCount: incorrect });
}

export async function submitAttempt(req, res) {
  const attempt = await Attempt.findOne({ quizId: req.params.quizId, userId: req.user._id });
  if (!attempt) throw httpError(404, "No attempt found");
  if (attempt.status === "terminated" || attempt.attemptStatus === "TERMINATED") {
    throw httpError(409, "This quiz attempt has been terminated.", "ATTEMPT_TERMINATED");
  }
  if (req.body.sessionId !== attempt.sessionId) {
    throw httpError(409, "Another active quiz session owns this attempt.", "SESSION_MISMATCH");
  }
  if (attempt.status === "in_progress") {
    attempt.status = "submitted";
    attempt.attemptStatus = "SUBMITTED";
    attempt.submittedAt = new Date();
    attempt.timeTaken = Date.now() - new Date(attempt.startedAt).getTime();
    await scoreAttempt(attempt);
  }
  return getResults(req, res);
}

export async function getResults(req, res) {
  const quiz = await Quiz.findById(req.params.quizId).lean();
  if (!quiz) throw httpError(404, "Quiz not found");
  const attempt = await Attempt.findOne({ quizId: quiz._id, userId: req.user._id }).lean();
  if (!attempt) throw httpError(404, "No results yet");
  if (attempt.status === "in_progress") throw httpError(400, "Quiz is still in progress");
  const questions = await Question.find({ quizId: quiz._id }).sort({ order: 1 }).lean();
  const answers = await Answer.find({ attemptId: attempt._id }).lean();
  const show = req.user.role === "admin" || quiz.showAnswersAfter;
  res.json({
    quiz,
    totalQuestions: questions.length,
    attemptedQuestions: attempt.attemptedCount,
    correctAnswers: attempt.correctCount,
    incorrectAnswers: attempt.incorrectCount,
    score: attempt.score,
    percentage: questions.length ? Math.round((attempt.correctCount / questions.length) * 100) : 0,
    rank: null,
    timeTaken: attempt.timeTaken,
    integrityStatus: attempt.integrityStatus || "CLEAN",
    integrityViolationCount: attempt.integrityViolationCount || 0,
    integrityEvents: attempt.integrityEvents || [],
    attemptStatus: attempt.attemptStatus || (attempt.status === "expired" ? "EXPIRED" : "SUBMITTED"),
    terminationReason: attempt.terminationReason || null,
    terminatedAt: attempt.terminatedAt || null,
    terminatedBy: attempt.terminatedBy || null,
    status: attempt.status,
    review: show
      ? questions.map((q) => {
          const ans = answers.find((a) => String(a.questionId) === String(q._id));
          return {
            question: q.text,
            options: q.options,
            selectedOptionId: ans?.selectedOptionId || null,
            correctOptionId: q.correctOptionId,
            explanation: q.explanation,
            isCorrect: Boolean(ans?.isCorrect),
          };
        })
      : null,
  });
}

export async function leaderboard(req, res) {
  const [participants, quiz] = await Promise.all([
    Participant.find({ quizId: req.params.quizId }).lean(),
    Quiz.findById(req.params.quizId).select("createdBy teamMode").lean(),
  ]);
  if (quiz?.teamMode) {
    const [teams, answers] = await Promise.all([
      Team.find({ quizId: req.params.quizId }).populate("members", "name").lean(),
      Answer.find({ quizId: req.params.quizId }).lean(),
    ]);
    const rows = teams.map((team) => {
      const members = participants.filter((participant) => String(participant.teamId) === String(team._id));
      const teamAnswers = answers.filter((answer) => String(answer.teamId) === String(team._id));
      return {
        id: team._id,
        name: team.name,
        kind: "team",
        score: members.reduce((score, participant) => Math.max(score, participant.score || 0), 0),
        correct: members.reduce((count, participant) => count + (participant.correctCount || 0), 0),
        incorrect: members.reduce((count, participant) => count + (participant.incorrectCount || 0), 0),
        responseTime: teamAnswers.length ? teamAnswers.reduce((sum, answer) => sum + (answer.responseTimeMs || 0), 0) / teamAnswers.length : 0,
        members: team.members.map((member) => member.name),
      };
    }).sort((a, b) => b.score - a.score || a.responseTime - b.responseTime)
      .map((row, index) => ({ ...row, rank: index + 1 }));
    return res.json(rows);
  }
  const canViewAllIntegrity = req.user.role === "admin" && String(quiz?.createdBy) === String(req.user._id);
  const rows = participants
    .map((p) => ({
      id: p._id,
      userId: p.userId,
      name: p.name,
      kind: "individual",
      score: p.score || 0,
      correct: p.correctCount || 0,
      incorrect: p.incorrectCount || 0,
      ...(canViewAllIntegrity || String(p.userId) === String(req.user._id)
        ? {
            integrityStatus: p.integrityStatus || "CLEAN",
            integrityViolationCount: p.integrityViolationCount || 0,
            integrityEvents: p.integrityEvents || [],
          }
        : {}),
    }))
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  res.json(rows);
}

export async function analytics(req, res) {
  const quizzes = await Quiz.find({ createdBy: req.user._id }).lean();
  const quizIds = quizzes.map((quiz) => quiz._id);
  const [participants, questions, answers, attempts, teams] = await Promise.all([
    Participant.find({ quizId: { $in: quizIds } }).lean(),
    Question.find({ quizId: { $in: quizIds } }).lean(),
    Answer.find({ quizId: { $in: quizIds } }).lean(),
    Attempt.find({ quizId: { $in: quizIds } }).lean(),
    Team.find({ quizId: { $in: quizIds } }).lean(),
  ]);
  const correct = answers.filter((answer) => answer.isCorrect).length;
  const incorrect = answers.filter((answer) => answer.isCorrect === false).length;
  const completed = attempts.filter((attempt) => ["submitted", "expired", "terminated"].includes(attempt.status)).length;
  const byDay = {};
  participants.forEach((participant) => {
    const day = new Date(participant.joinedAt).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  });
  res.json({
    overview: {
      totalQuizzes: quizzes.length,
      activeQuizzes: quizzes.filter((q) => computeQuizStatus(q) === "LIVE").length,
      scheduledQuizzes: quizzes.filter((q) => computeQuizStatus(q) === "SCHEDULED").length,
      completedQuizzes: quizzes.filter((q) => ["COMPLETED", "EXPIRED"].includes(computeQuizStatus(q))).length,
      totalParticipants: participants.length,
      totalQuestions: questions.length,
      totalTeams: teams.length,
      recent: quizzes
        .slice()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 8)
        .map((quiz) => ({
          ...quiz,
          computedStatus: computeQuizStatus(quiz),
          participantCount: participants.filter((participant) => String(participant.quizId) === String(quiz._id)).length,
          questionCount: questions.filter((question) => String(question.quizId) === String(quiz._id)).length,
        })),
    },
    participantsPerQuiz: quizzes.map((q) => ({
      name: q.title,
      participants: participants.filter((p) => String(p.quizId) === String(q._id)).length,
    })),
    correctVsIncorrect: [
      { name: "Correct", value: correct },
      { name: "Incorrect", value: incorrect },
    ],
    completionRate: attempts.length
      ? Math.round((completed / attempts.length) * 100)
      : 0,
    avgScore: quizzes.map((quiz) => {
      const rows = participants.filter((participant) => String(participant.quizId) === String(quiz._id));
      const score = rows.length ? rows.reduce((sum, participant) => sum + (participant.score || 0), 0) / rows.length : 0;
      return { name: quiz.title.length > 18 ? `${quiz.title.slice(0, 18)}…` : quiz.title, score: Number(score.toFixed(2)) };
    }),
    questionAccuracy: questions.slice(0, 16).map((question) => {
      const rows = answers.filter((answer) => String(answer.questionId) === String(question._id));
      const right = rows.filter((answer) => answer.isCorrect).length;
      return { name: `Q${question.order + 1}`, accuracy: rows.length ? Math.round((right / rows.length) * 100) : 0, responses: rows.length };
    }),
    participationOverTime: Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
    topPerformers: participants
      .slice()
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 8)
      .map((participant) => ({ name: participant.name, score: participant.score || 0, quiz: quizzes.find((quiz) => String(quiz._id) === String(participant.quizId))?.title || "" })),
    totals: { answers: answers.length, correct, incorrect, attempts: attempts.length, completed },
  });
}

export async function quizAnalytics(req, res) {
  const quiz = await Quiz.findOne({ _id: req.params.quizId, createdBy: req.user._id }).lean();
  if (!quiz) throw httpError(404, "Quiz not found");
  const [participants, teams, answers, questions, winners, attempts] = await Promise.all([
    Participant.find({ quizId: quiz._id }).lean(),
    Team.find({ quizId: quiz._id }).lean(),
    Answer.find({ quizId: quiz._id }).lean(),
    Question.find({ quizId: quiz._id }).sort({ order: 1 }).lean(),
    GameWinner.find({ quizId: quiz._id }).lean(),
    Attempt.find({ quizId: quiz._id }).lean(),
  ]);
  const scores = participants.map((p) => p.score || 0);
  const completed = attempts.filter((attempt) => attempt.status !== "in_progress").length;
  res.json({
    quiz,
    totalParticipants: participants.length,
    totalTeams: teams.length,
    completionRate: attempts.length ? Math.round((completed / attempts.length) * 100) : participants.length ? 100 : 0,
    averageScore: scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : 0,
    highestScore: scores.length ? Math.max(...scores) : 0,
    lowestScore: scores.length ? Math.min(...scores) : 0,
    correctPercent: answers.length ? Math.round((answers.filter((a) => a.isCorrect).length / answers.length) * 100) : 0,
    incorrectPercent: answers.length ? Math.round((answers.filter((a) => !a.isCorrect).length / answers.length) * 100) : 0,
    averageResponseTime: answers.length ? Math.round(answers.reduce((sum, answer) => sum + (answer.responseTimeMs || 0), 0) / answers.length) : 0,
    questionStats: questions.map((q) => {
      const ans = answers.filter((a) => String(a.questionId) === String(q._id));
      const c = ans.filter((a) => a.isCorrect).length;
      return {
        id: q._id,
        text: q.text,
        total: ans.length,
        correct: c,
        incorrect: ans.length - c,
        accuracy: ans.length ? Math.round((c / ans.length) * 100) : 0,
        averageResponseTime: ans.length ? Math.round(ans.reduce((sum, answer) => sum + (answer.responseTimeMs || 0), 0) / ans.length) : 0,
      };
    }),
    winners,
    rankings: participants.sort((a, b) => (b.score || 0) - (a.score || 0)),
  });
}

export async function startQuiz(req, res) {
  const quiz = await Quiz.findById(req.params.id);
  if (!quiz) throw httpError(404, "Quiz not found");
  if (["EXPIRED", "COMPLETED", "CANCELLED"].includes(quiz.status)) throw httpError(400, "Cannot start this quiz");
  quiz.status = "LIVE";
  quiz.lobbyOpen = true;
  quiz.startedAt = new Date();
  await quiz.save();
  req.app.get("io")?.to(`quiz:${quiz._id}`).emit("quiz:start", { quizId: String(quiz._id), serverNow: Date.now() });
  res.json(quiz);
}

export async function endQuiz(req, res) {
  const quiz = await Quiz.findById(req.params.id);
  if (!quiz) throw httpError(404, "Quiz not found");
  quiz.status = "COMPLETED";
  quiz.endedAt = new Date();
  quiz.lobbyOpen = false;
  await quiz.save();
  req.app.get("io")?.to(`quiz:${quiz._id}`).emit("quiz:end", { quizId: String(quiz._id) });
  res.json(quiz);
}

export async function listParticipants(req, res) {
  const quiz = await Quiz.findById(req.params.quizId).select("createdBy").lean();
  if (!quiz) throw httpError(404, "Quiz not found");
  if (req.user.role === "admin" && String(quiz.createdBy) !== String(req.user._id)) throw httpError(404, "Quiz not found");
  const participants = await Participant.find({ quizId: req.params.quizId }).lean();
  res.json(participants.map((participant) => {
    if (req.user.role === "admin" || String(participant.userId) === String(req.user._id)) return participant;
    const {
      integrityStatus,
      integrityViolationCount,
      integrityEvents,
      lastIntegrityEventAt,
      lastHeartbeatAt,
      ...visible
    } = participant;
    return visible;
  }));
}

export async function listTeams(req, res) {
  const quiz = await Quiz.findById(req.params.quizId).select("createdBy").lean();
  if (!quiz) throw httpError(404, "Quiz not found");
  if (req.user.role === "admin" && String(quiz.createdBy) !== String(req.user._id)) throw httpError(404, "Quiz not found");
  const teams = await Team.find({ quizId: req.params.quizId }).populate("members", "name").lean();
  res.json(teams.map((team) => ({ ...team, memberCount: team.members.length, members: team.members.map((member) => member.name) })));
}

export async function searchPeople(req, res) {
  if (req.user.role !== "admin") throw httpError(403, "Admin access required");
  const search = String(req.query.search || "").trim().toLowerCase();
  const quizzes = await Quiz.find({ createdBy: req.user._id }).select("title").lean();
  const quizIds = quizzes.map((quiz) => quiz._id);
  const [participants, teams] = await Promise.all([
    Participant.find({ quizId: { $in: quizIds } }).sort({ joinedAt: -1 }).limit(500).lean(),
    Team.find({ quizId: { $in: quizIds } }).sort({ createdAt: -1 }).limit(500).lean(),
  ]);
  const titles = new Map(quizzes.map((quiz) => [String(quiz._id), quiz.title]));
  res.json({
    participants: participants.filter((participant) => !search || (participant.name || "").toLowerCase().includes(search)).slice(0, 50).map((participant) => ({ ...participant, quizTitle: titles.get(String(participant.quizId)) })),
    teams: teams.filter((team) => !search || team.name.toLowerCase().includes(search) || team.code.toLowerCase().includes(search)).slice(0, 50).map((team) => ({ ...team, quizTitle: titles.get(String(team.quizId)), memberCount: team.members.length })),
  });
}

export async function lookup(req, res) {
  const quiz = await Quiz.findOne({ quizCode: (req.query.code || "").toUpperCase() }).lean();
  if (!quiz) throw httpError(404, "Invalid quiz code");
  res.json({
    _id: quiz._id,
    title: quiz.title,
    mode: quiz.mode,
    status: computeQuizStatus(quiz),
    teamMode: quiz.teamMode,
    quizCode: quiz.quizCode,
    description: quiz.description,
    lobbyOpen: quiz.lobbyOpen,
  });
}
