import jwt from "jsonwebtoken";
import { Answer, GameWinner, Participant, Question, Quiz, Team, User } from "../models/index.js";
import { computeQuizStatus, sanitizeQuestion } from "../utils/helpers.js";

function room(id) {
  return `quiz:${id}`;
}

async function identity(socket) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) throw new Error("Authentication required");
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(payload.id).lean();
  if (!user) throw new Error("Invalid session");
  return user;
}

async function liveState(quizId, user) {
  const quiz = await Quiz.findById(quizId).lean();
  if (!quiz) throw new Error("Quiz not found");
  const questions = await Question.find({ quizId }).sort({ order: 1 }).lean();
  const current = questions.find((q) => String(q._id) === String(quiz.currentQuestionId)) || null;
  const storedParticipants = await Participant.find({ quizId }).lean();
  const adminOwnsQuiz = user.role === "admin" && String(quiz.createdBy) === String(user._id);
  const participants = storedParticipants.map((participant) => {
    const visible = adminOwnsQuiz || String(participant.userId) === String(user._id)
      ? participant
      : (({ integrityStatus, integrityViolationCount, integrityEvents, lastIntegrityEventAt, lastHeartbeatAt, ...rest }) => rest)(participant);
    return { ...visible, connected: Boolean(participant.socketId) };
  });
  const answers = current ? await Answer.find({ questionId: current._id }).lean() : [];
  const winners = await GameWinner.find({ quizId }).lean();
  const participant = storedParticipants.find((item) => String(item.userId) === String(user._id)) || null;
  const myAnswer = current && participant
    ? answers.find((answer) => String(answer.participantId) === String(participant._id) ||
      (quiz.teamMode && participant.teamId && String(answer.teamId) === String(participant.teamId)))
    : null;
  let remaining = null;
  if (current && quiz.questionStartedAt) {
    const limit = (current.timeLimit || 30) * 1000;
    remaining = quiz.questionPaused ? quiz.pausedRemaining ?? 0 : Math.max(0, new Date(quiz.questionStartedAt).getTime() + limit - Date.now());
  }
  const questionEnded = Boolean(current && (quiz.questionPaused && quiz.pausedRemaining === 0 || remaining === 0));
  const hide = user.role !== "admin" && !questionEnded;
  const optionCounts = Object.fromEntries((current?.options || []).map((option) => [
    option.id,
    answers.filter((answer) => answer.selectedOptionId === option.id).length,
  ]));
  let leaderboard;
  if (quiz.teamMode) {
    const [teams, allAnswers] = await Promise.all([
      Team.find({ quizId }).populate("members", "name").lean(),
      Answer.find({ quizId }).lean(),
    ]);
    leaderboard = teams.map((team) => {
      const members = storedParticipants.filter((item) => String(item.teamId) === String(team._id));
      const teamAnswers = allAnswers.filter((answer) => String(answer.teamId) === String(team._id));
      return {
        id: team._id,
        name: team.name,
        kind: "team",
        score: members.reduce((score, item) => Math.max(score, item.score || 0), 0),
        correct: members.reduce((count, item) => count + (item.correctCount || 0), 0),
        incorrect: members.reduce((count, item) => count + (item.incorrectCount || 0), 0),
        responseTime: teamAnswers.length ? teamAnswers.reduce((sum, answer) => sum + (answer.responseTimeMs || 0), 0) / teamAnswers.length : 0,
        members: team.members.map((member) => member.name),
      };
    }).sort((a, b) => b.score - a.score || a.responseTime - b.responseTime)
      .map((item, index) => ({ ...item, rank: index + 1 }));
  } else {
    leaderboard = storedParticipants
      .map((item) => ({
        id: item._id,
        userId: item.userId,
        name: item.name,
        kind: "individual",
        score: item.score || 0,
        correct: item.correctCount || 0,
        incorrect: item.incorrectCount || 0,
        ...(adminOwnsQuiz || String(item.userId) === String(user._id) ? {
          integrityStatus: item.integrityStatus || "CLEAN",
          integrityViolationCount: item.integrityViolationCount || 0,
          integrityEvents: item.integrityEvents || [],
        } : {}),
      }))
      .sort((a, b) => b.score - a.score)
      .map((item, index) => ({ ...item, rank: index + 1 }));
  }
  return {
    quiz: { ...quiz, computedStatus: computeQuizStatus(quiz) },
    currentQuestion: current ? sanitizeQuestion(current, hide) : null,
    index: quiz.currentQuestionIndex,
    total: questions.length,
    remaining,
    serverNow: Date.now(),
    participants,
    winners,
    participant,
    hasAnswered: Boolean(myAnswer),
    mySelectedOptionId: myAnswer?.selectedOptionId || null,
    questionEnded,
    paused: Boolean(quiz.questionPaused && !questionEnded),
    connectedCount: storedParticipants.filter((item) => item.socketId).length,
    leaderboard,
    stats: current
      ? {
          questionId: current._id,
          total: answers.length,
          correct: answers.filter((a) => a.isCorrect).length,
          incorrect: answers.filter((a) => !a.isCorrect).length,
          unanswered: Math.max(0, participants.length - answers.length),
          optionCounts,
          winner: winners.find((winner) => String(winner.questionId) === String(current._id)) || null,
        }
      : null,
  };
}

export function attachSockets(io) {
  io.use(async (socket, next) => {
    try {
      socket.user = await identity(socket);
      next();
    } catch (e) {
      next(new Error(e.message));
    }
  });

  io.on("connection", (socket) => {
    socket.on("quiz:join", async ({ quizId }, cb) => {
      try {
        const participant = await Participant.findOne({ quizId, userId: socket.user._id }).select("attemptStatus").lean();
        if (participant?.attemptStatus === "TERMINATED") {
          const error = new Error("This quiz attempt has been terminated.");
          error.code = "ATTEMPT_TERMINATED";
          throw error;
        }
        socket.join(room(quizId));
        await Participant.updateOne({ quizId, userId: socket.user._id }, { socketId: socket.id });
        socket.to(room(quizId)).emit("quiz:participantJoined", {
          quizId,
          participant: { name: socket.user.name, userId: socket.user._id },
        });
        const state = await liveState(quizId, socket.user);
        cb?.({ ok: true, state });
      } catch (e) {
        cb?.({ ok: false, code: e.code, message: e.message });
      }
    });

    socket.on("quiz:adminJoin", async ({ quizId }, cb) => {
      try {
        if (socket.user.role !== "admin") throw new Error("Admin access required");
        const quiz = await Quiz.findOne({ _id: quizId, createdBy: socket.user._id }).select("_id").lean();
        if (!quiz) throw new Error("Quiz not found");
        socket.join(room(quizId));
        socket.join(`${room(quizId)}:admins`);
        cb?.({ ok: true });
      } catch (e) {
        cb?.({ ok: false, message: e.message });
      }
    });

    socket.on("quiz:state", async ({ quizId }, cb) => {
      try {
        const quiz = await Quiz.findById(quizId).select("createdBy").lean();
        if (!quiz) throw new Error("Quiz not found");
        if (socket.user.role === "admin") {
          if (String(quiz.createdBy) !== String(socket.user._id)) throw new Error("Quiz not found");
          socket.join(`${room(quizId)}:admins`);
        }
        socket.join(room(quizId));
        cb?.({ ok: true, state: await liveState(quizId, socket.user) });
      } catch (e) {
        cb?.({ ok: false, message: e.message });
      }
    });

    socket.on("quiz:openLobby", async ({ quizId }, cb) => {
      try {
        if (socket.user.role !== "admin") throw new Error("Admin access required");
        const quiz = await Quiz.findOne({ _id: quizId, createdBy: socket.user._id });
        if (!quiz) throw new Error("Quiz not found");
        if (!["live", "game"].includes(quiz.mode)) throw new Error("Lobby is for live and game quizzes");
        if (["COMPLETED", "EXPIRED", "CANCELLED"].includes(quiz.status)) throw new Error("Cannot open lobby for a finished quiz");
        quiz.lobbyOpen = true;
        if (quiz.status === "DRAFT") quiz.status = "SCHEDULED";
        await quiz.save();
        io.to(room(quizId)).emit("quiz:lobbyOpen", { quizId });
        cb?.({ ok: true });
      } catch (e) {
        cb?.({ ok: false, message: e.message });
      }
    });

    socket.on("quiz:start", async ({ quizId }, cb) => {
      try {
        if (socket.user.role !== "admin") throw new Error("Admin access required");
        const quiz = await Quiz.findOne({ _id: quizId, createdBy: socket.user._id });
        if (!quiz) throw new Error("Quiz not found");
        if (["EXPIRED", "COMPLETED", "CANCELLED"].includes(quiz.status)) throw new Error("Cannot start this quiz");
        const count = await Question.countDocuments({ quizId });
        if (!count) throw new Error("Add questions before starting");
        quiz.status = "LIVE";
        quiz.lobbyOpen = true;
        quiz.startedAt = new Date();
        await quiz.save();
        io.to(room(quizId)).emit("quiz:start", { quizId, serverNow: Date.now() });
        cb?.({ ok: true });
      } catch (e) {
        cb?.({ ok: false, message: e.message });
      }
    });

    socket.on("quiz:question", async ({ quizId, questionId }, cb) => {
      try {
        if (socket.user.role !== "admin") throw new Error("Admin access required");
        const quiz = await Quiz.findOne({ _id: quizId, createdBy: socket.user._id });
        if (!quiz) throw new Error("Quiz not found");
        const questions = await Question.find({ quizId }).sort({ order: 1 });
        const question = questionId
          ? questions.find((q) => String(q._id) === String(questionId))
          : questions[quiz.currentQuestionIndex + 1] || questions[0];
        if (!question) throw new Error("Question not found");
        quiz.status = "LIVE";
        quiz.currentQuestionId = question._id;
        quiz.currentQuestionIndex = questions.findIndex((q) => String(q._id) === String(question._id));
        quiz.questionStartedAt = new Date();
        quiz.questionPaused = false;
        quiz.pausedRemaining = null;
        await quiz.save();
        const payload = {
          quizId,
          question: sanitizeQuestion(question, true),
          index: quiz.currentQuestionIndex,
          total: questions.length,
          timeLimit: question.timeLimit,
          startedAt: quiz.questionStartedAt,
          serverNow: Date.now(),
        };
        io.to(room(quizId)).emit("quiz:question", payload);
        io.to(room(quizId)).emit("quiz:timer", { quizId, remaining: question.timeLimit * 1000, serverNow: Date.now() });
        cb?.({ ok: true });
      } catch (e) {
        cb?.({ ok: false, message: e.message });
      }
    });

    socket.on("quiz:pauseQuestion", async ({ quizId }, cb) => {
      try {
        if (socket.user.role !== "admin") throw new Error("Admin access required");
        const quiz = await Quiz.findOne({ _id: quizId, createdBy: socket.user._id });
        if (!quiz || !quiz.questionStartedAt || quiz.questionPaused) throw new Error("No active question to pause");
        const question = await Question.findById(quiz.currentQuestionId);
        const duration = (question?.timeLimit || 30) * 1000;
        quiz.pausedRemaining = Math.max(0, quiz.questionStartedAt.getTime() + duration - Date.now());
        quiz.questionPaused = true;
        await quiz.save();
        io.to(room(quizId)).emit("quiz:timer", { quizId, paused: true });
        cb?.({ ok: true });
      } catch (e) {
        cb?.({ ok: false, message: e.message });
      }
    });

    socket.on("quiz:resumeQuestion", async ({ quizId }, cb) => {
      try {
        if (socket.user.role !== "admin") throw new Error("Admin access required");
        const quiz = await Quiz.findOne({ _id: quizId, createdBy: socket.user._id });
        if (!quiz || !quiz.questionPaused || quiz.pausedRemaining === 0) throw new Error("This question has ended. Start the next question instead.");
        const question = await Question.findById(quiz.currentQuestionId);
        const duration = (question?.timeLimit || 30) * 1000;
        quiz.questionStartedAt = new Date(Date.now() - (duration - (quiz.pausedRemaining || 0)));
        quiz.questionPaused = false;
        quiz.pausedRemaining = null;
        await quiz.save();
        io.to(room(quizId)).emit("quiz:timer", { quizId, paused: false, serverNow: Date.now() });
        cb?.({ ok: true });
      } catch (e) {
        cb?.({ ok: false, message: e.message });
      }
    });

    socket.on("quiz:endQuestion", async ({ quizId }, cb) => {
      try {
        if (socket.user.role !== "admin") throw new Error("Admin access required");
        const quiz = await Quiz.findOne({ _id: quizId, createdBy: socket.user._id });
        if (!quiz || !quiz.currentQuestionId) throw new Error("No active question to end");
        quiz.questionPaused = true;
        quiz.pausedRemaining = 0;
        await quiz.save();
        const answers = await Answer.find({ questionId: quiz.currentQuestionId }).lean();
        const stats = { total: answers.length, correct: answers.filter((answer) => answer.isCorrect).length, incorrect: answers.filter((answer) => !answer.isCorrect).length };
        io.to(room(quizId)).emit("quiz:questionEnded", { quizId, stats });
        io.to(room(quizId)).emit("quiz:answerStats", { quizId, stats });
        cb?.({ ok: true });
      } catch (e) {
        cb?.({ ok: false, message: e.message });
      }
    });

    socket.on("quiz:nextQuestion", async ({ quizId }, cb) => {
      try {
        if (socket.user.role !== "admin") throw new Error("Admin access required");
        const quiz = await Quiz.findOne({ _id: quizId, createdBy: socket.user._id });
        if (!quiz) throw new Error("Quiz not found");
        const questions = await Question.find({ quizId }).sort({ order: 1 });
        const next = questions[quiz.currentQuestionIndex + 1] || questions[0];
        if (!next) {
          quiz.status = "COMPLETED";
          quiz.endedAt = new Date();
          quiz.lobbyOpen = false;
          quiz.questionPaused = true;
          await quiz.save();
          io.to(room(quizId)).emit("quiz:end", { quizId });
          cb?.({ ok: true });
          return;
        }
        quiz.status = "LIVE";
        quiz.currentQuestionId = next._id;
        quiz.currentQuestionIndex = questions.findIndex((question) => String(question._id) === String(next._id));
        quiz.questionStartedAt = new Date();
        quiz.questionPaused = false;
        quiz.pausedRemaining = null;
        await quiz.save();
        const payload = { quizId, question: sanitizeQuestion(next, true), index: quiz.currentQuestionIndex, total: questions.length, timeLimit: next.timeLimit, startedAt: quiz.questionStartedAt, serverNow: Date.now() };
        io.to(room(quizId)).emit("quiz:question", payload);
        io.to(room(quizId)).emit("quiz:timer", { quizId, remaining: next.timeLimit * 1000, serverNow: Date.now() });
        cb?.({ ok: true });
      } catch (e) {
        cb?.({ ok: false, message: e.message });
      }
    });

    socket.on("quiz:leave", async ({ quizId }, cb) => {
      socket.leave(room(quizId));
      await Participant.updateOne({ quizId, userId: socket.user._id, socketId: socket.id }, { $unset: { socketId: 1 } });
      socket.to(room(quizId)).emit("quiz:participantLeft", { quizId, userId: String(socket.user._id) });
      cb?.({ ok: true });
    });

    socket.on("quiz:end", async ({ quizId }, cb) => {
      try {
        if (socket.user.role !== "admin") throw new Error("Admin access required");
        const quiz = await Quiz.findOne({ _id: quizId, createdBy: socket.user._id });
        if (!quiz) throw new Error("Quiz not found");
        quiz.status = "COMPLETED";
        quiz.endedAt = new Date();
        quiz.lobbyOpen = false;
        quiz.questionPaused = true;
        await quiz.save();
        io.to(room(quizId)).emit("quiz:end", { quizId });
        cb?.({ ok: true });
      } catch (e) {
        cb?.({ ok: false, message: e.message });
      }
    });

    socket.on("quiz:answer", async ({ quizId, questionId, selectedOptionId, sessionId }, cb) => {
      try {
        const quiz = await Quiz.findById(quizId);
        if (!quiz || quiz.status !== "LIVE") throw new Error("Quiz is not live");
        if (String(quiz.currentQuestionId) !== String(questionId)) throw new Error("This question is not active");
        const question = await Question.findById(questionId);
        if (!question) throw new Error("Invalid question");
        const limit = (question.timeLimit || 30) * 1000;
        if (!quiz.questionPaused && quiz.questionStartedAt && Date.now() > new Date(quiz.questionStartedAt).getTime() + limit) {
          throw new Error("Time is up for this question");
        }
        const participant = await Participant.findOne({ quizId, userId: socket.user._id });
        if (!participant) throw new Error("Join the quiz first");
        if (participant.attemptStatus === "TERMINATED") {
          const error = new Error("This quiz attempt has been terminated.");
          error.code = "ATTEMPT_TERMINATED";
          throw error;
        }
        if (typeof sessionId !== "string" || participant.sessionId !== sessionId) {
          const error = new Error("Another active quiz session owns this attempt.");
          error.code = "SESSION_MISMATCH";
          throw error;
        }
        if (quiz.teamMode && participant.teamId) {
          const teamAnswer = await Answer.findOne({ quizId, questionId, teamId: participant.teamId });
          if (teamAnswer) throw new Error("Your team has already answered this question");
        }
        const existing = await Answer.findOne({ quizId, questionId, participantId: participant._id });
        if (existing) throw new Error("You have already answered this question");
        const isCorrect = selectedOptionId === question.correctOptionId;
        const pts = isCorrect ? question.points || quiz.marksPerQuestion || 1 : quiz.negativeMarking ? -(question.negativePoints || 0) : 0;
        await Participant.updateOne({ _id: participant._id }, {
          $inc: { score: pts, correctCount: isCorrect ? 1 : 0, incorrectCount: isCorrect ? 0 : 1 },
        });
        const answer = await Answer.create({
          quizId,
          questionId,
          participantId: participant._id,
          teamId: participant.teamId,
          userId: socket.user._id,
          selectedOptionId,
          isCorrect,
          serverTimestamp: new Date(),
          responseTimeMs: Date.now() - new Date(quiz.questionStartedAt).getTime(),
          pointsAwarded: pts,
        });
        let winner = null;
        if (quiz.mode === "game" && isCorrect) {
          try {
            winner = await GameWinner.create({
              quizId,
              questionId,
              participantId: participant._id,
              teamId: participant.teamId,
              userId: socket.user._id,
              submittedAnswer: selectedOptionId,
              correctness: true,
              serverTimestamp: new Date(),
              responseTimeMs: answer.responseTimeMs,
              winnerStatus: true,
              name: participant.name,
            });
            await Answer.updateOne({ _id: answer._id }, { isWinner: true });
            io.to(room(quizId)).emit("quiz:winner", { quizId, questionId, winner });
          } catch (err) {
            if (err.code !== 11000) throw err;
          }
        }
        io.to(room(quizId)).emit("quiz:answer", { quizId, questionId, participantId: participant._id, received: true });
        const answers = await Answer.find({ questionId });
        io.to(room(quizId)).emit("quiz:answerStats", {
          quizId,
          stats: {
            total: answers.length,
            correct: answers.filter((a) => a.isCorrect).length,
            incorrect: answers.filter((a) => !a.isCorrect).length,
          },
        });
        cb?.({ ok: true, isWinner: Boolean(winner) });
      } catch (e) {
        cb?.({ ok: false, code: e.code, message: e.message });
      }
    });

    socket.on("disconnect", async () => {
      await Participant.updateMany({ socketId: socket.id }, { $unset: { socketId: 1 } });
    });
  });
}
