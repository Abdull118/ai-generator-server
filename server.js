import express from "express";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";
import { MongoClient } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import { fileURLToPath } from 'url';
import cors from "cors";

// Define __dirname manually
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use(cors());

const mongoClient = new MongoClient(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

app.get("/keep-alive", (req, res) => {
  res.status(200).send("Alive and well");
});

app.post("/generate-questions", async (req, res) => {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { folder, fileName, sampleQuestions } = req.body;

    if (!folder || !fileName || !sampleQuestions) {
      return res.status(400).json({ error: "Folder, fileName, and sampleQuestions are required." });
    }

    const filePath = path.join(__dirname, "data", folder, fileName);
    const data = await fs.readFile(filePath, "utf-8");

    const assistant = await openai.beta.assistants.create({
      name: "Data Question Generator",
      instructions: "You are a question generator. Based on provided data and sample questions, generate new questions in the same style.",
      model: "gpt-4o",
    });

    const thread = await openai.beta.threads.create();
    const message = await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: `
Data:
${data}

Sample Questions:
${sampleQuestions}

Generate 5 new questions in the same style as the examples. Return the data in a JSON Object in the format: question, answer_choices, answer.
      `,
    });

    let run = await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: assistant.id,
      instructions: "Please only return the JSON object, no other information.",
    });

    if (run.status === "completed") {
      const messages = await openai.beta.threads.messages.list(run.thread_id);
      const assistantMessage = messages.data.find((msg) => msg.role === "assistant");

      if (assistantMessage) {
        const content = assistantMessage.content[0].text.value;
        const cleanedContent = content.replace(/```json|```/g, "").trim();
        const rawQuestions = JSON.parse(cleanedContent);

        // Add unique IDs to each question
        const newQuestions = rawQuestions.map((question) => ({
          ...question,
          id: uuidv4(),
        }));

        await mongoClient.connect();
        const db = mongoClient.db();
        const collectionName = `${folder}_${fileName}`;
        const collection = db.collection(collectionName);

        const existingDocument = await collection.findOne({ folder, fileName });

        if (existingDocument) {
          await collection.updateOne(
            { folder, fileName },
            { $push: { questions: { $each: newQuestions } } }
          );
        } else {
          await collection.insertOne({
            folder,
            fileName,
            questions: newQuestions,
            createdAt: new Date(),
          });
        }

        await mongoClient.close();
        return res.status(200).json({ message: "Questions updated successfully." });
      } else {
        return res.status(500).json({ error: "Assistant response not found." });
      }
    } else {
      return res.status(500).json({ error: `Run status: ${run.status}` });
    }
  } catch (error) {
    console.error("Error:", error.message);
    return res.status(500).json({ error: "An error occurred while processing your request." });
  } finally {
    await mongoClient.close();
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
