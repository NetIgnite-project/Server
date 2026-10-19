import { TaskHandler } from "@cleverjs/utils";

export const SampleTask = new TaskHandler.BasicTaskFn("sampleTask", async (payload, logger) => {
	logger.info("Executing SampleTask with payload:", payload);

	return { success: true, message: "SampleTask executed successfully." };
});
