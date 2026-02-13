# Workspace Instructions (Read First)
   
- never use an environment variable -- put hard-wired constant values at the top of the file with uppercase names
- don't use file missing fallbacks -- if a file is missing then die fast
- prefer async over sync code -- avoid using void to fix async/await problems
- don't make changes unrelated to problem being worked on 
- don't make cosmetic changes
- do not use gpt file for copilot chat prompts -- it is just a scratchpad for editing the prompts before using
- only use the rules file when directed to -- it will be instructions for action
- don't consider open files to be special - i will add the files that should get special focus in the copilot chat interface
- ignore files in misc folder -- do not read files -- do not use file contents as part of prompt
